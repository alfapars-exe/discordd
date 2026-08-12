package main

// wiring_test.go — completeness check for the "SetX defined but never
// called" bug class (P1.7). ws.Hub.SetVoiceAdminAuthorizer was defined,
// exported, and wired into main.go's registerHubCallbacks sequence... except
// nothing ever called it, so authorizeVoiceModeration (ws/hub_callbacks.go)
// always fell back to its nil-authorizer "allow everything" branch — a
// fail-open defense-in-depth gate that compiled clean and passed every
// existing test, because nothing asserted the setter was actually reached.
//
// This test statically collects every DI-style setter method defined in
// ./services and ./ws, and every `.SetXxx(...)` call site in this package's
// own (non-test) source files, and fails if a defined setter has fewer
// call sites than definitions sharing its name. Uses only go/ast + go/parser
// (no go/types) — see isWiringSetter's doc comment for why that keeps this
// name-based rather than fully type-precise, and why that's still useful.

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// allowedUnwiredSetters lists setter names that legitimately have fewer
// `.SetXxx(` call sites in package main than definitions sharing that name.
// Empty right now: every DI setter in ./services and ./ws as of this test's
// authoring is wired somewhere in package main. A future addition here MUST
// carry a reason comment — an empty reason is itself a red flag that the
// setter was just forgotten, not deliberately left unwired.
var allowedUnwiredSetters = map[string]string{}

// setterDef is one Set<X> method definition found in ./services or ./ws.
type setterDef struct {
	pkg    string // "services" or "ws" — for failure messages only
	recv   string // receiver type name, e.g. "voiceService"
	method string
	pos    token.Position
}

// countParamNames returns the total number of parameter *names* a field
// list binds. "func F(a, b string)" is a single ast.Field with two Names
// and must count as 2 parameters, not 1 — a naive len(fl.List) would
// undercount grouped parameters.
func countParamNames(fl *ast.FieldList) int {
	if fl == nil {
		return 0
	}
	n := 0
	for _, f := range fl.List {
		if len(f.Names) == 0 {
			n++ // unnamed parameter still counts as one
			continue
		}
		n += len(f.Names)
	}
	return n
}

// isWiringSetter applies the signature heuristic that separates a true
// dependency-injection setter from a same-named business-logic method that
// also happens to start with "Set" (SetOverride(ctx, ...) error,
// SetPlatformAdmin(ctx, ...) error, SetNickname(ctx, ...) (X, error) — all
// real methods in ./services, all called from handlers per-request, none of
// them wiring). Verified by hand against every Set<X> method in ./services
// and ./ws as of this test's authoring: every genuine wiring setter
// (SetAppLogger, SetAuditLogger's former call sites, SetMusicBotHook,
// SetVoiceAdminAuthorizer, SetPermInvalidator, SetUserCacheInvalidator,
// SetVoiceDisconnecter, SetUploadDir, SetDMAcceptor, ...) takes exactly one
// parameter and returns nothing; every business method named Set<X> takes a
// context.Context plus more and returns a value and/or error. This also
// cleanly excludes ws.Hub's SetInvisible/SetClientServerIDs/SetUserInfo
// (2-4 params, no return, per-event notifications rather than one-time
// wiring) without needing to special-case them.
func isWiringSetter(ft *ast.FuncType) bool {
	if countParamNames(ft.Params) != 1 {
		return false
	}
	return ft.Results == nil || len(ft.Results.List) == 0
}

// looksLikeSetterName reports whether name follows the SetX exported-setter
// convention: "Set" followed by an upper-case ASCII letter.
func looksLikeSetterName(name string) bool {
	if !strings.HasPrefix(name, "Set") || len(name) <= len("Set") {
		return false
	}
	c := name[len("Set")]
	return c >= 'A' && c <= 'Z'
}

func receiverTypeName(recv *ast.FieldList) string {
	if recv == nil || len(recv.List) == 0 {
		return ""
	}
	expr := recv.List[0].Type
	if star, ok := expr.(*ast.StarExpr); ok {
		expr = star.X
	}
	if ident, ok := expr.(*ast.Ident); ok {
		return ident.Name
	}
	return ""
}

// collectSetterDefs walks every non-test *.go file directly in dir (both
// ./services and ./ws are flat packages, no subdirectories) and returns
// every method matching isWiringSetter.
func collectSetterDefs(t *testing.T, dir, pkgLabel string) []setterDef {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		t.Fatalf("glob %s: %v", dir, err)
	}
	if len(paths) == 0 {
		t.Fatalf("glob %s matched no files — wrong cwd? test expects cwd=server/", dir)
	}

	fset := token.NewFileSet()
	var defs []setterDef
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil {
				continue
			}
			name := fn.Name.Name
			if !looksLikeSetterName(name) || !ast.IsExported(name) {
				continue
			}
			if !isWiringSetter(fn.Type) {
				continue
			}
			defs = append(defs, setterDef{
				pkg:    pkgLabel,
				recv:   receiverTypeName(fn.Recv),
				method: name,
				pos:    fset.Position(fn.Pos()),
			})
		}
	}
	return defs
}

// collectMainSetterCallCounts walks every non-test *.go file directly in
// "." (package main's own directory — server/) and counts `.SetXxx(` call
// expressions by method name.
func collectMainSetterCallCounts(t *testing.T) map[string]int {
	t.Helper()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob .: %v", err)
	}
	if len(paths) == 0 {
		t.Fatal(`glob "*.go" matched no files in "." — wrong cwd? test expects cwd=server/`)
	}

	fset := token.NewFileSet()
	counts := make(map[string]int)
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, path, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", path, err)
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			if looksLikeSetterName(sel.Sel.Name) {
				counts[sel.Sel.Name]++
			}
			return true
		})
	}
	return counts
}

// TestWiring_EveryDefinedSetterIsCalledFromMain is the completeness check
// described in this file's top doc comment.
//
// Non-vacuity check performed by hand while authoring this test: commenting
// out `hub.SetVoiceAdminAuthorizer(...)` in main.go turns this test red
// (SetVoiceAdminAuthorizer: 1 definition, 0 calls); restoring the line turns
// it green again.
func TestWiring_EveryDefinedSetterIsCalledFromMain(t *testing.T) {
	var defs []setterDef
	defs = append(defs, collectSetterDefs(t, "services", "services")...)
	defs = append(defs, collectSetterDefs(t, "ws", "ws")...)

	defsByName := make(map[string][]setterDef)
	for _, d := range defs {
		defsByName[d.method] = append(defsByName[d.method], d)
	}

	callCounts := collectMainSetterCallCounts(t)

	var names []string
	for name := range defsByName {
		names = append(names, name)
	}
	sort.Strings(names)

	for _, name := range names {
		group := defsByName[name]
		needed := len(group)
		got := callCounts[name]
		if got >= needed {
			continue
		}
		if reason, ok := allowedUnwiredSetters[name]; ok {
			if reason == "" {
				t.Errorf("%s: allowedUnwiredSetters entry has an empty reason — every allowlist entry must justify why it's safe to leave unwired", name)
			}
			continue
		}
		var locs []string
		for _, d := range group {
			locs = append(locs, d.pkg+"."+d.recv+"."+d.method+" ("+d.pos.String()+")")
		}
		t.Errorf(
			"%s: %d definition(s) but only %d call site(s) in package main — a setter that compiles but is never called silently no-ops its wiring (see this file's doc comment for the SetVoiceAdminAuthorizer incident). Definitions:\n  %s",
			name, needed, got, strings.Join(locs, "\n  "),
		)
	}
}
