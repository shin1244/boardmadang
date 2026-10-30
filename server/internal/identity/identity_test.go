package identity

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

var secret = []byte("test-secret-test-secret-test-secret")

func TestGuestRoundTrip(t *testing.T) {
	is := NewIssuer(secret)
	g, err := is.NewGuest()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(g.ID, "g_") || g.Kind != KindGuest || len(g.Tag) != 4 {
		t.Fatalf("bad guest: %+v", g)
	}
	got, ok := is.Verify(is.Sign(g))
	if !ok || got != g {
		t.Fatalf("Verify = %+v, %v; want %+v", got, ok, g)
	}
}

func TestGuestsDiffer(t *testing.T) {
	is := NewIssuer(secret)
	a, _ := is.NewGuest()
	b, _ := is.NewGuest()
	if a.ID == b.ID {
		t.Fatalf("two guests got the same id %q", a.ID)
	}
}

func TestRejectsTampering(t *testing.T) {
	is := NewIssuer(secret)
	g, _ := is.NewGuest()
	token := is.Sign(g)
	parts := strings.Split(token, ".")

	// 내용을 계정으로 바꿔치기
	forged, _ := json.Marshal(payload{ID: "m_admin", Kind: KindMember, IssuedAt: time.Now().Unix()})
	parts[1] = base64.RawURLEncoding.EncodeToString(forged)
	cases := map[string]string{
		"payload swapped": strings.Join(parts, "."),
		"other secret":    NewIssuer([]byte("another-secret-another-secret-xx")).Sign(g),
		"no signature":    strings.Join(parts[:2], "."),
		"garbage":         "hello",
		"empty":           "",
	}
	for name, tok := range cases {
		if u, ok := is.Verify(tok); ok {
			t.Errorf("%s: accepted %+v", name, u)
		}
	}
}

func TestRejectsKindMismatch(t *testing.T) {
	is := NewIssuer(secret)
	// 서명은 맞지만 id 접두어와 kind가 다른 토큰
	if _, ok := is.Verify(is.Sign(User{ID: "g_abc", Kind: KindMember})); ok {
		t.Error("guest id with member kind accepted")
	}
}

func TestExpiry(t *testing.T) {
	now := time.Now()
	is := NewIssuer(secret)
	is.now = func() time.Time { return now }
	g, _ := is.NewGuest()
	token := is.Sign(g)

	is.now = func() time.Time { return now.Add(MaxAge - time.Hour) }
	if _, ok := is.Verify(token); !ok {
		t.Error("rejected before MaxAge")
	}
	is.now = func() time.Time { return now.Add(MaxAge + time.Hour) }
	if _, ok := is.Verify(token); ok {
		t.Error("accepted after MaxAge")
	}
	is.now = func() time.Time { return now.Add(-time.Hour) } // 미래에 발급된 토큰
	if _, ok := is.Verify(token); ok {
		t.Error("accepted token issued in the future")
	}
}

func TestHandleMeIssuesAndKeepsGuest(t *testing.T) {
	is := NewIssuer(secret)

	rec := httptest.NewRecorder()
	is.HandleMe(rec, httptest.NewRequest("GET", "/api/me", nil))
	var first User
	json.NewDecoder(rec.Body).Decode(&first)
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != CookieName || !cookies[0].HttpOnly {
		t.Fatalf("cookie not set properly: %+v", cookies)
	}
	if first.Kind != KindGuest {
		t.Fatalf("first visit kind = %q, want guest", first.Kind)
	}

	// 받은 쿠키로 다시 오면 같은 게스트
	req := httptest.NewRequest("GET", "/api/me", nil)
	req.AddCookie(cookies[0])
	rec = httptest.NewRecorder()
	is.HandleMe(rec, req)
	var second User
	json.NewDecoder(rec.Body).Decode(&second)
	if second != first {
		t.Fatalf("second visit = %+v, want %+v", second, first)
	}

	// 깨진 쿠키면 새 게스트
	req = httptest.NewRequest("GET", "/api/me", nil)
	req.AddCookie(&http.Cookie{Name: CookieName, Value: "broken"})
	rec = httptest.NewRecorder()
	is.HandleMe(rec, req)
	var third User
	json.NewDecoder(rec.Body).Decode(&third)
	if third.ID == "" || third.ID == first.ID {
		t.Fatalf("broken cookie should give a new guest, got %+v", third)
	}
}

func TestSecureCookieBehindHTTPS(t *testing.T) {
	is := NewIssuer(secret)
	req := httptest.NewRequest("GET", "/api/me", nil)
	req.Header.Set("X-Forwarded-Proto", "https")
	rec := httptest.NewRecorder()
	is.HandleMe(rec, req)
	if c := rec.Result().Cookies(); len(c) != 1 || !c[0].Secure {
		t.Fatalf("cookie should be Secure behind https: %+v", c)
	}
}

// members는 테스트용 계정 저장소입니다.
type members map[string]string

func (m members) Name(id string) (string, bool) {
	name, ok := m[id]
	return name, ok
}

func TestMemberNameFromStore(t *testing.T) {
	is := NewIssuer(secret)
	token := is.Sign(Member("m_shin", "old"))

	if _, ok := is.Verify(token); ok {
		t.Error("member accepted without a store")
	}
	is.Members = members{"m_shin": "shin"}
	got, ok := is.Verify(token)
	if !ok || got != Member("m_shin", "shin") {
		t.Errorf("Verify = %+v, %v; want name from store", got, ok)
	}
	is.Members = members{}
	if _, ok := is.Verify(token); ok {
		t.Error("deleted member accepted")
	}
}

func TestClearCookie(t *testing.T) {
	is := NewIssuer(secret)
	rec := httptest.NewRecorder()
	is.ClearCookie(rec, httptest.NewRequest("POST", "/auth/logout", nil))
	if c := rec.Result().Cookies(); len(c) != 1 || c[0].Name != CookieName || c[0].MaxAge >= 0 {
		t.Fatalf("cookie not cleared: %+v", c)
	}
}

func TestRequireMember(t *testing.T) {
	is := NewIssuer(secret)
	is.Members = members{"m_test": "test"}
	h := is.RequireMember(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	guest, _ := is.NewGuest()
	member := User{ID: "m_test", Kind: KindMember}

	for name, tc := range map[string]struct {
		cookie *http.Cookie
		want   int
	}{
		"no session": {nil, http.StatusUnauthorized},
		"guest":      {&http.Cookie{Name: CookieName, Value: is.Sign(guest)}, http.StatusForbidden},
		"member":     {&http.Cookie{Name: CookieName, Value: is.Sign(member)}, http.StatusNoContent},
	} {
		req := httptest.NewRequest("PUT", "/api/games/x/listing", nil)
		if tc.cookie != nil {
			req.AddCookie(tc.cookie)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("%s: status = %d, want %d", name, rec.Code, tc.want)
		}
	}
}
