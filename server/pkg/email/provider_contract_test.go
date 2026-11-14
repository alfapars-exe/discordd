package email

import (
	"reflect"
	"testing"
)

func TestResendConstructorDeclaresAllConfiguredCapabilities(t *testing.T) {
	result := reflect.TypeOf(NewResendSender).Out(0)
	for _, required := range []reflect.Type{reflect.TypeFor[EmailSender](), reflect.TypeFor[VerificationSender](), reflect.TypeFor[CategorySender]()} {
		if !result.Implements(required) {
			t.Errorf("configured provider result %s omits %s", result, required)
		}
	}
}
