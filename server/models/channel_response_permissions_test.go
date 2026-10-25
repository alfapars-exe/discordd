package models

import (
	"encoding/json"
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestChannelResponsePermissionMetadataContract(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		channel := Channel{ID: "channel"}
		zero := Permission(0)
		if explicit {
			channel.EffectivePermissions = &zero
		}
		data, err := json.Marshal(channel)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]json.RawMessage
		if err = json.Unmarshal(data, &fields); err != nil {
			t.Fatal(err)
		}
		value, present := fields["effective_permissions"]
		if present != explicit {
			t.Fatal("optional zero-permission metadata was lost or invented")
		}
		if explicit && string(value) != "0" {
			t.Fatalf("unexpected permission encoding: %s", value)
		}
	}
	data, err := os.ReadFile("../openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var spec struct {
		Components struct {
			Schemas map[string]struct {
				Properties map[string]struct {
					Type any `yaml:"type"` // OpenAPI 3.1 also permits a type array.
				} `yaml:"properties"`
				Required []string `yaml:"required"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err = yaml.Unmarshal(data, &spec); err != nil {
		t.Fatal(err)
	}
	schema := spec.Components.Schemas["Channel"]
	if schema.Properties["effective_permissions"].Type != "integer" {
		t.Fatal("permission metadata missing from OpenAPI")
	}
	for _, required := range schema.Required {
		if required == "effective_permissions" {
			t.Fatal("response-only metadata must remain optional")
		}
	}
}
