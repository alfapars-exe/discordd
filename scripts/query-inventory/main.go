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
	Unresolved int        `json:"unresolved_calls"`
	Calls      []callSite `json:"candidate_calls"`
}

func inventory(root string) (report, error) {
	result := report{Scope: "Non-test server/repository Go source; method-name candidates, not verified database receivers. Only direct string literals are resolved.", Calls: []callSite{}}
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
			literal, ok := call.Args[index].(*ast.BasicLit)
			if ok && literal.Kind == token.STRING {
				value, err := strconv.Unquote(literal.Value)
				if err == nil {
					site.SQL = value
					result.Literal++
				} else {
					result.Unresolved++
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
