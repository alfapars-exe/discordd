// Command query-inventory reports candidate repository SQL call sites.
// It inventories syntax; it does not prove execution, dialect parity or coverage.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type callSite struct {
	File       string `json:"file"`
	Line       int    `json:"line"`
	Method     string `json:"method"`
	Expression string `json:"expression_kind"`
	SQL        string `json:"literal_sql,omitempty"`
}
type report struct {
	Scope      string     `json:"scope"`
	Files      int        `json:"parsed_files"`
	Literal    int        `json:"literal_calls"`
	Constants  int        `json:"constant_calls"`
	Unresolved int        `json:"unresolved_calls"`
	Calls      []callSite `json:"candidate_calls"`
}

// Resolve only syntax proven constant, following parser object bindings so local
// shadowing cannot borrow another query. Mutable variables and imported constants
// deliberately remain unresolved. Cycles and excessive nesting fail closed.
func constantSQL(expr ast.Expr, seen map[*ast.Object]bool) (string, bool) {
	if len(seen) > 64 {
		return "", false
	}
	switch value := expr.(type) {
	case *ast.BasicLit:
		if value.Kind != token.STRING {
			return "", false
		}
		text, err := strconv.Unquote(value.Value)
		return text, err == nil
	case *ast.ParenExpr:
		return constantSQL(value.X, seen)
	case *ast.BinaryExpr:
		if value.Op != token.ADD {
			return "", false
		}
		left, a := constantSQL(value.X, seen)
		right, b := constantSQL(value.Y, seen)
		return left + right, a && b
	case *ast.Ident:
		obj := value.Obj
		if obj == nil || obj.Kind != ast.Con || seen[obj] {
			return "", false
		}
		declaration, ok := obj.Decl.(*ast.ValueSpec)
		if !ok || len(declaration.Values) != len(declaration.Names) {
			return "", false
		}
		seen[obj] = true
		defer delete(seen, obj)
		for i, name := range declaration.Names {
			if name.Name == value.Name {
				return constantSQL(declaration.Values[i], seen)
			}
		}
	}
	return "", false
}

func inventory(root string) (report, error) {
	result := report{Scope: "Non-test server/repository Go source; method-name candidates, not verified database receivers. Direct literals and same-file explicit string constants are resolved; mutable expressions remain unresolved.", Calls: []callSite{}}
	directory := filepath.Join(root, "server", "repository")
	positions := token.NewFileSet()
	err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		file, err := parser.ParseFile(positions, path, nil, 0)
		if err != nil {
			return err
		}
		result.Files++
		ast.Inspect(file, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			method, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			index := 0
			switch method.Sel.Name {
			case "ExecContext", "QueryContext", "QueryRowContext", "PrepareContext":
				index = 1
			case "Exec", "Query", "QueryRow", "Prepare":
			default:
				return true
			}
			if len(call.Args) <= index {
				return true
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				rel = path
			}
			site := callSite{File: filepath.ToSlash(rel), Line: positions.Position(call.Pos()).Line, Method: method.Sel.Name, Expression: fmt.Sprintf("%T", call.Args[index])}
			if value, ok := constantSQL(call.Args[index], make(map[*ast.Object]bool)); ok {
				site.SQL = value
				if _, direct := call.Args[index].(*ast.BasicLit); direct {
					result.Literal++
				} else {
					result.Constants++
				}
			} else {
				result.Unresolved++
			}

			result.Calls = append(result.Calls, site)
			return true
		})
		return nil
	})
	return result, err
}
func main() {
	root := flag.String("root", ".", "repository root")
	flag.Parse()
	result, err := inventory(*root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
