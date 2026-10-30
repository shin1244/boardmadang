// Package auth는 Google과 GitHub 소셜 로그인입니다 (OAuth 2.0 authorization code). 설계는 docs/identity.md에 있습니다.
//
//	GET  /api/auth/providers         켜져 있는 로그인 방법 {"providers":["google","github"]}
//	GET  /auth/{provider}?next=/web/ 로그인 시작. 그곳의 로그인 화면으로 보냅니다
//	GET  /auth/{provider}/callback   그곳에서 돌아오는 주소. 계정이 있으면 세션 쿠키를 계정으로 바꾸고,
//	                                 처음 온 사람이면 이름을 정하는 화면(/web/signup.html)으로 보냅니다
//	GET  /auth/signup                이름을 정하는 중인 가입 정보 {"provider":"github","suggested":"octo"}
//	POST /auth/signup                이름을 정해 계정을 만듭니다 {"name":"..."} → {"next":"/web/..."}
//	POST /auth/logout                로그아웃. 세션 쿠키를 지웁니다 (다음 /api/me에서 새 게스트)
//
// 그곳에서 받은 토큰은 사용자 번호와 이름을 읽는 데만 쓰고 버립니다.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/shin1244/boardmadang/server/internal/account"
	"github.com/shin1244/boardmadang/server/internal/identity"
	"github.com/shin1244/boardmadang/server/internal/record"
)

const (
	// stateCookie는 로그인을 시작한 브라우저가 돌아온 브라우저인지 확인하는 값입니다 (CSRF 막기).
	stateCookie = "bm_oauth"
	stateMaxAge = 10 * time.Minute

	// signupCookie는 처음 온 사람이 이름을 정하는 동안 들고 있는 가입 정보입니다 (서명한 값).
	signupCookie = "bm_signup"
	signupMaxAge = 30 * time.Minute
	SignupPage   = "/web/signup.html"
)

// signup은 signupCookie의 내용입니다.
type signup struct {
	Provider  string `json:"p"`
	Sub       string `json:"s"`
	Suggested string `json:"n,omitempty"`
	Next      string `json:"next"`
	Expires   int64  `json:"exp"`
}

// Provider는 로그인할 수 있는 곳 하나입니다.
type Provider struct {
	Name         string // google, github. 주소와 계정 기록에 쓰입니다
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	Scope        string
	Extra        url.Values // 로그인 화면 주소에 더 붙일 값

	// profile은 받은 토큰으로 사용자 번호(바뀌지 않는 값)와 화면 이름을 읽습니다.
	profile func(ctx context.Context, c *http.Client, token string) (sub, name string, err error)
	// ProfileURL은 profile이 읽는 주소입니다. 테스트에서 바꾸려고 둡니다.
	ProfileURL string

	direct bool // 외부에 묻지 않고 바로 로그인합니다 (Dev)
}

// Dev는 개발용 로그인입니다 (DEV_LOGIN=1). OAuth 앱 없이 바로 "dev" 계정으로 로그인해서
// 의견, 방 만들기처럼 계정만 되는 기능을 내 컴퓨터에서 시험합니다. 운영에서는 절대 켜지 않습니다.
func Dev() *Provider { return &Provider{Name: "dev", direct: true} }

// Google은 Google 로그인입니다. 받은 이름은 이름 칸의 기본값으로만 씁니다. 공개되는 곳이라 성을 빼고 이름(given_name)만 씁니다.
func Google(clientID, clientSecret string) *Provider {
	p := &Provider{
		Name:         "google",
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
		TokenURL:     "https://oauth2.googleapis.com/token",
		Scope:        "openid profile",
		Extra:        url.Values{"prompt": {"select_account"}},
		ProfileURL:   "https://openidconnect.googleapis.com/v1/userinfo",
	}
	p.profile = func(ctx context.Context, c *http.Client, token string) (string, string, error) {
		var u struct {
			Sub       string `json:"sub"`
			Name      string `json:"name"`
			GivenName string `json:"given_name"`
		}
		if err := getJSON(ctx, c, p.ProfileURL, token, &u); err != nil {
			return "", "", err
		}
		if u.GivenName != "" {
			return u.Sub, u.GivenName, nil
		}
		return u.Sub, u.Name, nil
	}
	return p
}

// GitHub은 GitHub 로그인입니다. 이름 칸의 기본값은 GitHub 아이디(login)입니다. 공개 정보만 읽으므로 scope가 없습니다.
func GitHub(clientID, clientSecret string) *Provider {
	p := &Provider{
		Name:         "github",
		ClientID:     clientID,
		ClientSecret: clientSecret,
		AuthURL:      "https://github.com/login/oauth/authorize",
		TokenURL:     "https://github.com/login/oauth/access_token",
		ProfileURL:   "https://api.github.com/user",
	}
	p.profile = func(ctx context.Context, c *http.Client, token string) (string, string, error) {
		var u struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
		}
		if err := getJSON(ctx, c, p.ProfileURL, token, &u); err != nil {
			return "", "", err
		}
		if u.ID == 0 {
			return "", "", errors.New("github: no user id")
		}
		return strconv.FormatInt(u.ID, 10), u.Login, nil
	}
	return p
}

// Handler는 로그인 API입니다.
type Handler struct {
	Providers []*Provider // 켜진 것만. 이 순서로 화면에 보입니다
	IDs       *identity.Issuer
	Accounts  *account.Store
	Records   *record.Store // 있으면 로그인할 때 게스트의 대국을 계정으로 옮깁니다
	// PublicURL은 브라우저가 보는 사이트 주소입니다 (https://boardmadang.com). 돌아올 주소를 만들 때 씁니다.
	// 비어 있으면 요청의 Host로 만듭니다 (개발용).
	PublicURL string
	Client    *http.Client // 비어 있으면 10초 타임아웃의 기본 클라이언트
}

func (h *Handler) provider(name string) *Provider {
	for _, p := range h.Providers {
		if p.Name == name {
			return p
		}
	}
	return nil
}

func (h *Handler) client() *http.Client {
	if h.Client != nil {
		return h.Client
	}
	return &http.Client{Timeout: 10 * time.Second}
}

func (h *Handler) callbackURL(r *http.Request, p *Provider) string {
	base := strings.TrimRight(h.PublicURL, "/")
	if base == "" {
		scheme := "http"
		if identity.IsHTTPS(r) {
			scheme = "https"
		}
		base = scheme + "://" + r.Host
	}
	return base + "/auth/" + p.Name + "/callback"
}

// ServeProviders는 GET /api/auth/providers 입니다. 화면은 여기 있는 것만 로그인 버튼으로 보여줍니다.
func (h *Handler) ServeProviders(w http.ResponseWriter, r *http.Request) {
	names := []string{}
	for _, p := range h.Providers {
		names = append(names, p.Name)
	}
	writeJSON(w, http.StatusOK, map[string][]string{"providers": names})
}

// ServeLogin은 GET /auth/{provider} 입니다. 무작위 state를 쿠키에 넣고 그곳의 로그인 화면으로 보냅니다.
func (h *Handler) ServeLogin(w http.ResponseWriter, r *http.Request) {
	p := h.provider(r.PathValue("provider"))
	if p == nil {
		http.NotFound(w, r)
		return
	}
	next := safeNext(r.URL.Query().Get("next"))
	if p.direct {
		w.Header().Set("Cache-Control", "no-store")
		h.finish(w, r, p, "dev", "dev", next)
		return
	}
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		http.Error(w, "server error", http.StatusInternalServerError)
		return
	}
	state := base64.RawURLEncoding.EncodeToString(b)
	http.SetCookie(w, &http.Cookie{
		Name:     stateCookie,
		Value:    p.Name + "." + state + "." + base64.RawURLEncoding.EncodeToString([]byte(next)),
		Path:     "/auth/",
		MaxAge:   int(stateMaxAge / time.Second),
		HttpOnly: true,
		Secure:   identity.IsHTTPS(r),
		// 그곳에서 돌아오는 것은 다른 사이트에서 오는 이동(GET)이라 Lax여야 쿠키가 같이 옵니다.
		SameSite: http.SameSiteLaxMode,
	})
	q := url.Values{
		"client_id":     {p.ClientID},
		"redirect_uri":  {h.callbackURL(r, p)},
		"response_type": {"code"},
		"state":         {state},
	}
	if p.Scope != "" {
		q.Set("scope", p.Scope)
	}
	for k, v := range p.Extra {
		q[k] = v
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, p.AuthURL+"?"+q.Encode(), http.StatusFound)
}

// ServeCallback은 GET /auth/{provider}/callback 입니다.
// 실패하면 시작한 화면으로 돌아가며 주소에 ?login_error=<이유>를 붙입니다.
func (h *Handler) ServeCallback(w http.ResponseWriter, r *http.Request) {
	p := h.provider(r.PathValue("provider"))
	if p == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-store")

	// state 쿠키는 한 번만 씁니다.
	http.SetCookie(w, &http.Cookie{Name: stateCookie, Path: "/auth/", MaxAge: -1, HttpOnly: true, Secure: identity.IsHTTPS(r), SameSite: http.SameSiteLaxMode})
	next := "/web/"
	c, err := r.Cookie(stateCookie)
	if err != nil {
		h.fail(w, r, next, "expired", nil)
		return
	}
	parts := strings.Split(c.Value, ".")
	if len(parts) != 3 {
		h.fail(w, r, next, "expired", nil)
		return
	}
	if raw, err := base64.RawURLEncoding.DecodeString(parts[2]); err == nil {
		next = safeNext(string(raw))
	}
	q := r.URL.Query()
	if parts[0] != p.Name || q.Get("state") == "" || subtle.ConstantTimeCompare([]byte(parts[1]), []byte(q.Get("state"))) != 1 {
		h.fail(w, r, next, "state", nil)
		return
	}
	if q.Get("error") != "" { // 그곳에서 사용자가 취소함
		h.fail(w, r, next, "cancelled", nil)
		return
	}

	ctx := r.Context()
	token, err := h.exchange(ctx, r, p, q.Get("code"))
	if err != nil {
		h.fail(w, r, next, "provider", err)
		return
	}
	sub, name, err := p.profile(ctx, h.client(), token)
	if err != nil || sub == "" {
		h.fail(w, r, next, "provider", err)
		return
	}
	h.finish(w, r, p, sub, name, next)
}

// finish는 그곳에서 확인한 사람을 로그인시킵니다. 계정이 있으면 바로 로그인하고,
// 처음 온 사람이면 가입 정보를 서명해 쿠키에 넣고 이름을 정하는 화면으로 보냅니다.
func (h *Handler) finish(w http.ResponseWriter, r *http.Request, p *Provider, sub, name, next string) {
	if member, ok := h.Accounts.Find(p.Name, sub); ok {
		h.signIn(w, r, member)
		http.Redirect(w, r, next, http.StatusFound)
		return
	}
	data, _ := json.Marshal(signup{Provider: p.Name, Sub: sub, Suggested: account.Suggest(name), Next: next, Expires: time.Now().Add(signupMaxAge).Unix()})
	http.SetCookie(w, &http.Cookie{
		Name:     signupCookie,
		Value:    h.IDs.SignData("signup", data),
		Path:     "/auth/",
		MaxAge:   int(signupMaxAge / time.Second),
		HttpOnly: true,
		Secure:   identity.IsHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, SignupPage, http.StatusFound)
}

// signIn은 세션 쿠키를 member로 바꿉니다. 쓰던 쿠키가 게스트면 그 게스트로 둔 대국을 계정으로 옮깁니다 (실패해도 로그인은 됩니다).
func (h *Handler) signIn(w http.ResponseWriter, r *http.Request, member identity.User) {
	if prev, ok := h.IDs.FromRequest(r); ok && !prev.IsMember() && h.Records != nil {
		to := record.Player{ID: member.ID, Kind: member.Kind, Tag: member.Tag, Name: member.Name}
		if n, err := h.Records.Adopt(prev.ID, to); err != nil {
			log.Printf("게스트 %s의 대국을 %s로 옮기지 못했습니다: %v", prev.ID, member.ID, err)
		} else if n > 0 {
			log.Printf("게스트 %s의 대국 %d개를 %s로 옮겼습니다", prev.ID, n, member.ID)
		}
	}
	h.IDs.SetCookie(w, r, member)
}

// pendingSignup은 요청의 가입 정보입니다. 없거나, 위조됐거나, 시간이 지났으면 false입니다.
func (h *Handler) pendingSignup(r *http.Request) (signup, bool) {
	c, err := r.Cookie(signupCookie)
	if err != nil {
		return signup{}, false
	}
	data, ok := h.IDs.VerifyData("signup", c.Value)
	if !ok {
		return signup{}, false
	}
	var su signup
	if json.Unmarshal(data, &su) != nil || su.Sub == "" || h.provider(su.Provider) == nil || time.Now().Unix() > su.Expires {
		return signup{}, false
	}
	return su, true
}

// ServeSignupInfo는 GET /auth/signup 입니다. 이름 칸의 기본값과 어디로 로그인했는지를 줍니다.
func (h *Handler) ServeSignupInfo(w http.ResponseWriter, r *http.Request) {
	su, ok := h.pendingSignup(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "expired"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"provider": su.Provider, "suggested": su.Suggested,
		"min": account.MinName, "max": account.MaxName,
	})
}

// ServeSignup은 POST /auth/signup 입니다. 이름을 확인해 계정을 만들고 로그인시킵니다.
// JSON 본문만 받습니다 (다른 사이트의 폼으로 남의 브라우저에서 가입시키지 못하게).
func (h *Handler) ServeSignup(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		writeJSON(w, http.StatusUnsupportedMediaType, map[string]string{"error": "JSON only"})
		return
	}
	su, ok := h.pendingSignup(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "expired"})
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body) != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad JSON"})
		return
	}
	member, created, err := h.Accounts.Create(su.Provider, su.Sub, body.Name)
	if errors.Is(err, account.ErrNameLength) || errors.Is(err, account.ErrNameChars) || errors.Is(err, account.ErrNameReserved) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		log.Printf("계정을 만들지 못했습니다: %v", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server error"})
		return
	}
	if created {
		log.Printf("새 계정 %s (%s)", member.ID, su.Provider)
	}
	http.SetCookie(w, &http.Cookie{Name: signupCookie, Path: "/auth/", MaxAge: -1, HttpOnly: true, Secure: identity.IsHTTPS(r), SameSite: http.SameSiteLaxMode})
	h.signIn(w, r, member)
	writeJSON(w, http.StatusOK, map[string]string{"next": su.Next})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (h *Handler) fail(w http.ResponseWriter, r *http.Request, next, reason string, err error) {
	if err != nil {
		log.Printf("로그인 실패 (%s): %v", reason, err)
	}
	u, _ := url.Parse(next)
	q := u.Query()
	q.Set("login_error", reason)
	u.RawQuery = q.Encode()
	http.Redirect(w, r, u.String(), http.StatusFound)
}

// exchange는 돌아올 때 받은 code를 토큰으로 바꿉니다.
func (h *Handler) exchange(ctx context.Context, r *http.Request, p *Provider, code string) (string, error) {
	if code == "" {
		return "", errors.New("no code")
	}
	form := url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {h.callbackURL(r, p)},
		"client_id":     {p.ClientID},
		"client_secret": {p.ClientSecret},
	}
	req, err := http.NewRequestWithContext(ctx, "POST", p.TokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json") // GitHub은 이게 없으면 form 모양으로 답합니다
	res, err := h.client().Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var body struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("token: status %d: %w", res.StatusCode, err)
	}
	if body.AccessToken == "" {
		return "", fmt.Errorf("token: status %d: %s", res.StatusCode, body.Error)
	}
	return body.AccessToken, nil
}

func getJSON(ctx context.Context, c *http.Client, u, token string, v any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: status %d", u, res.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(v)
}

// ServeLogout은 POST /auth/logout 입니다. 다른 사이트가 로그아웃시키지 못하게 같은 출처의 요청만 받습니다.
func (h *Handler) ServeLogout(w http.ResponseWriter, r *http.Request) {
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "same-origin" {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	h.IDs.ClearCookie(w, r)
	w.WriteHeader(http.StatusNoContent)
}

// safeNext는 로그인 뒤에 돌아갈 주소입니다. 이 사이트 안의 경로만 받습니다 (다른 사이트로 보내는 데 쓰이지 않게).
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.ContainsAny(next, "\\\r\n") {
		return "/web/"
	}
	u, err := url.Parse(next)
	if err != nil || u.Host != "" || u.Scheme != "" {
		return "/web/"
	}
	// 지난번 실패 표시는 떼고 돌아갑니다.
	q := u.Query()
	if q.Has("login_error") {
		q.Del("login_error")
		u.RawQuery = q.Encode()
	}
	return u.String()
}
