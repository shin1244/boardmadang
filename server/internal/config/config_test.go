package config

import (
	"reflect"
	"testing"
)

func TestLoadDefaults(t *testing.T) {
	t.Setenv("PORT", "")
	t.Setenv("ALLOWED_ORIGINS", "")
	t.Setenv("SITE_DIR", "")

	cfg := Load()
	if cfg.SiteDir != ".." {
		t.Errorf("SiteDir = %q, want .. (server/에서 go run 할 때의 레포 루트)", cfg.SiteDir)
	}
	if cfg.Port != "8080" {
		t.Errorf("Port = %q, want 8080", cfg.Port)
	}
	if len(cfg.AllowedOrigins) != 0 {
		t.Errorf("AllowedOrigins = %v, want empty", cfg.AllowedOrigins)
	}
}

func TestLoadOrigins(t *testing.T) {
	t.Setenv("ALLOWED_ORIGINS", " https://a.example , ,https://b.example")

	got := Load().AllowedOrigins
	want := []string{"https://a.example", "https://b.example"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("AllowedOrigins = %v, want %v", got, want)
	}
}
