package account

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/shin1244/boardmadang/server/internal/identity"
)

func TestHTTP(t *testing.T) {
	s, now := open(t, t.TempDir())
	ids := identity.NewIssuer([]byte(strings.Repeat("k", 32)))
	ids.Members = s
	var forgot []string
	h := Handler{Store: s, IDs: ids, Forget: []func(string) error{
		func(id string) error { forgot = append(forgot, "a:"+id); return errors.New("disk full") },
		func(id string) error { forgot = append(forgot, "b:"+id); return nil }, // 앞이 실패해도 부릅니다
	}}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/account", h.ServeGet)
	mux.HandleFunc("PATCH /api/account", h.ServeRename)
	mux.HandleFunc("DELETE /api/account", h.ServeDelete)

	me, _, _ := s.Create("github", "42", "shin")
	cookie := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(me)}
	guest, _ := ids.NewGuest()
	guestCookie := &http.Cookie{Name: identity.CookieName, Value: ids.Sign(guest)}

	do := func(method, ctype, body string, c *http.Cookie) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "/api/account", strings.NewReader(body))
		if ctype != "" {
			req.Header.Set("Content-Type", ctype)
		}
		if c != nil {
			req.AddCookie(c)
		}
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	errorOf := func(rec *httptest.ResponseRecorder) string {
		var body struct{ Error string }
		json.Unmarshal(rec.Body.Bytes(), &body)
		return body.Error
	}

	if rec := do("GET", "", "", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("no cookie: %d", rec.Code)
	}
	if rec := do("GET", "", "", guestCookie); rec.Code != http.StatusForbidden {
		t.Fatalf("guest: %d", rec.Code)
	}
	rec := do("GET", "", "", cookie)
	var info Info
	if json.Unmarshal(rec.Body.Bytes(), &info); rec.Code != 200 || info.Name != "shin" || info.Provider != "github" || !info.RenameAfter.IsZero() || info.Max != MaxName {
		t.Fatalf("get = %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), "renameAfter") || strings.Contains(rec.Body.String(), `"42"`) {
		t.Fatalf("지금 바꿀 수 있으면 renameAfter가 없고, 로그인한 곳의 번호는 보내지 않습니다: %s", rec.Body)
	}

	// 이름 바꾸기
	if rec := do("PATCH", "text/plain", `{"name":"new"}`, cookie); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("form body: %d", rec.Code)
	}
	if rec := do("PATCH", "application/json", `{"name":"a"}`, cookie); rec.Code != 400 || errorOf(rec) != "name length" {
		t.Fatalf("short name: %d %s", rec.Code, rec.Body)
	}
	if rec := do("PATCH", "application/json", `{"name":"shin"}`, cookie); rec.Code != 400 || errorOf(rec) != "name same" {
		t.Fatalf("same name: %d %s", rec.Code, rec.Body)
	}
	rec = do("PATCH", "application/json", `{"name":"junkyu"}`, cookie)
	if json.Unmarshal(rec.Body.Bytes(), &info); rec.Code != 200 || info.Name != "junkyu" || !info.RenameAfter.Equal(now.Add(RenameEvery)) {
		t.Fatalf("rename = %d %s", rec.Code, rec.Body)
	}
	// 토큰은 그대로인데 이름은 새 이름입니다
	if u, ok := ids.Verify(cookie.Value); !ok || u.Name != "junkyu" {
		t.Fatalf("Verify after rename = %+v, %v", u, ok)
	}
	*now = now.Add(time.Hour)
	rec = do("PATCH", "application/json", `{"name":"again"}`, cookie)
	if rec.Code != http.StatusTooManyRequests || errorOf(rec) != "rename too soon" || !strings.Contains(rec.Body.String(), "renameAfter") {
		t.Fatalf("too soon: %d %s", rec.Code, rec.Body)
	}

	// 탈퇴는 지금 이름을 그대로 적어야 합니다
	if rec := do("DELETE", "application/json", `{"confirm":"shin"}`, cookie); rec.Code != 400 || errorOf(rec) != "confirm" {
		t.Fatalf("old name as confirm: %d %s", rec.Code, rec.Body)
	}
	if rec := do("DELETE", "", `{"confirm":"junkyu"}`, cookie); rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("delete without JSON: %d", rec.Code)
	}
	if len(forgot) != 0 {
		t.Fatalf("forgot before delete: %v", forgot)
	}
	rec = do("DELETE", "application/json", `{"confirm":" junkyu "}`, cookie)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if c := rec.Result().Cookies(); len(c) != 1 || c[0].Name != identity.CookieName || c[0].MaxAge >= 0 {
		t.Fatalf("세션 쿠키를 지워야 합니다: %+v", c)
	}
	if want := []string{"a:" + me.ID, "b:" + me.ID}; strings.Join(forgot, ",") != strings.Join(want, ",") {
		t.Fatalf("forgot = %v, want %v", forgot, want)
	}
	// 지운 계정의 토큰은 더 받지 않습니다
	if _, ok := ids.Verify(cookie.Value); ok {
		t.Fatal("deleted account's token still works")
	}
	if rec := do("GET", "", "", cookie); rec.Code != http.StatusUnauthorized {
		t.Fatalf("get after delete: %d", rec.Code)
	}
}
