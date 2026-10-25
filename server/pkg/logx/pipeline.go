package logx

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"reflect"
	"strings"
	"sync/atomic"

	"github.com/argeinfina/hichat/pkg"
)

type appSink struct {
	emit func(context.Context, slog.Record)
}

var applicationSink atomic.Pointer[appSink]

// SetAppSink binds a non-blocking consumer after the database services exist.
// Passing nil detaches it before shutdown; stdout remains available throughout.
func SetAppSink(emit func(context.Context, slog.Record)) {
	if emit == nil {
		applicationSink.Store(nil)
		return
	}
	applicationSink.Store(&appSink{emit: emit})
}

type handlerOp struct {
	attrs []slog.Attr
	group string
}
type forwardedTarget struct {
	logger  *slog.Logger
	handler slog.Handler
}
type forwardHandler struct {
	ops    []handlerOp
	cached atomic.Pointer[forwardedTarget]
}

func (h *forwardHandler) target() slog.Handler {
	logger := slog.Default()
	if cached := h.cached.Load(); cached != nil && cached.logger == logger {
		return cached.handler
	}
	target := logger.Handler()
	for _, op := range h.ops {
		if op.group != "" {
			target = target.WithGroup(op.group)
		} else {
			target = target.WithAttrs(op.attrs)
		}
	}
	h.cached.Store(&forwardedTarget{logger: logger, handler: target})
	return target
}
func (h *forwardHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return slog.Default().Enabled(ctx, l)
}
func (h *forwardHandler) Handle(ctx context.Context, r slog.Record) error {
	return h.target().Handle(ctx, r)
}
func (h *forwardHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return &forwardHandler{ops: appendOp(h.ops, handlerOp{attrs: append([]slog.Attr(nil), a...)})}
}
func (h *forwardHandler) WithGroup(g string) slog.Handler {
	return &forwardHandler{ops: appendOp(h.ops, handlerOp{group: g})}
}
func appendOp(ops []handlerOp, op handlerOp) []handlerOp {
	out := append([]handlerOp(nil), ops...)
	return append(out, op)
}

// pipelineHandler sanitizes before fan-out, including attributes installed via
// With/WithGroup. All sinks see the same safe, immutable record.
type pipelineHandler struct {
	next slog.Handler
	ops  []handlerOp
}

func (h *pipelineHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return h.next.Enabled(ctx, l)
}
func (h *pipelineHandler) WithAttrs(a []slog.Attr) slog.Handler {
	return &pipelineHandler{next: h.next, ops: appendOp(h.ops, handlerOp{attrs: append([]slog.Attr(nil), a...)})}
}
func (h *pipelineHandler) WithGroup(g string) slog.Handler {
	return &pipelineHandler{next: h.next, ops: appendOp(h.ops, handlerOp{group: g})}
}
func (h *pipelineHandler) Handle(ctx context.Context, r slog.Record) error {
	attrs := make([]slog.Attr, 0, r.NumAttrs()+8)
	groups := []string{}
	add := func(a slog.Attr) {
		for i := len(groups) - 1; i >= 0; i-- {
			a = slog.Attr{Key: groups[i], Value: slog.GroupValue(a)}
		}
		attrs = mergeLogAttr(attrs, a)
	}
	for _, op := range h.ops {
		if op.group != "" {
			groups = append(groups, op.group)
		} else {
			for _, a := range op.attrs {
				add(a)
			}
		}
	}
	r.Attrs(func(a slog.Attr) bool { add(a); return true })
	safe := slog.NewRecord(r.Time, r.Level, pkg.SafeLogString(r.Message, 1024), r.PC)
	component, kind, reqID := "", "", ""
	skip := false
	messageJSON, _ := json.Marshal(safe.Message)
	budget := 6500 - len(messageJSON)
	for _, a := range attrs {
		if a.Key == "component" {
			component = a.Value.String()
		}
		if a.Key == "event_kind" {
			kind = a.Value.String()
		}
		if a.Key == "request_id" {
			reqID = a.Value.String()
		}
		if a.Key == "skip_app_log" {
			skip = a.Value.Kind() == slog.KindBool && a.Value.Bool()
		}
		a = safeAttr(a)
		if r.Level >= slog.LevelWarn {
			encoded, _ := json.Marshal(map[string]any{a.Key: logValue(a.Value)})
			if len(encoded) > budget {
				continue
			}
			budget -= len(encoded)
		}
		safe.AddAttrs(a)
	}
	if reqID == "" {
		if id := pkg.RequestIDFrom(ctx); id != "" {
			safe.AddAttrs(slog.String("request_id", id))
		}
	}
	if sink := applicationSink.Load(); sink != nil && r.Level >= slog.LevelWarn && kind != "http_access" && !skip && !strings.HasPrefix(component, "service.applog") && !strings.HasPrefix(component, "app_log.") {
		sink.emit(ctx, safe)
	}
	return h.next.Handle(ctx, safe)
}

// WithGroup must yield one JSON object, not repeated keys whose earlier
// children disappear when a collector decodes the record.
func mergeLogAttr(attrs []slog.Attr, a slog.Attr) []slog.Attr {
	if a.Value.Kind() == slog.KindGroup {
		for i := len(attrs) - 1; i >= 0; i-- {
			if attrs[i].Key == a.Key && attrs[i].Value.Kind() == slog.KindGroup {
				children := append([]slog.Attr(nil), attrs[i].Value.Group()...)
				for _, child := range a.Value.Group() {
					children = mergeLogAttr(children, child)
				}
				attrs[i].Value = slog.GroupValue(children...)
				return attrs
			}
		}
	}
	return append(attrs, a)
}

func logValue(v slog.Value) any {
	if v.Kind() == slog.KindGroup {
		out := map[string]any{}
		for _, a := range v.Group() {
			out[a.Key] = logValue(a.Value)
		}
		return out
	}
	return v.Any()
}

func safeAttr(a slog.Attr) slog.Attr {
	a.Value = a.Value.Resolve()
	if pkg.IsSecretLogKey(a.Key) {
		return slog.String(a.Key, "***")
	}
	switch a.Value.Kind() {
	case slog.KindGroup:
		children := a.Value.Group()
		out := make([]slog.Attr, 0, len(children))
		for _, child := range children {
			out = append(out, safeAttr(child))
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(out...)}
	case slog.KindString:
		return slog.String(a.Key, pkg.SafeLogString(a.Value.String(), 4096))
	case slog.KindAny:
		return slog.Any(a.Key, safeAny(a.Value.Any(), 0))
	default:
		return a
	}
}

func safeAny(v any, depth int) any {
	if depth >= 4 {
		return "[depth limit]"
	}
	if err, ok := v.(error); ok {
		return pkg.SafeLogString(err.Error(), 4096)
	}
	if v == nil {
		return nil
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Map:
		out := map[string]any{}
		it := rv.MapRange()
		for i := 0; i < 64 && it.Next(); i++ {
			key := pkg.SafeLogString(fmt.Sprint(it.Key().Interface()), 128)
			if pkg.IsSecretLogKey(key) {
				out[key] = "***"
			} else {
				out[key] = safeAny(it.Value().Interface(), depth+1)
			}
		}
		return out
	case reflect.Array, reflect.Slice:
		out := make([]any, 0, min(rv.Len(), 64))
		for i := 0; i < min(rv.Len(), 64); i++ {
			out = append(out, safeAny(rv.Index(i).Interface(), depth+1))
		}
		return out
	case reflect.Bool:
		return rv.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return rv.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return rv.Uint()
	case reflect.Float32, reflect.Float64:
		return rv.Float()
	default:
		return pkg.SafeLogString(fmt.Sprint(v), 4096)
	}
}
