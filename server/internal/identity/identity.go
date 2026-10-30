// Package identity는 플레이어 신원(게스트와 계정)과 세션 쿠키를 다룹니다.
// 설계는 docs/identity.md에 있습니다.
//
// 서버는 게스트를 저장하지 않습니다. 서명한 토큰을 쿠키로 주고, 요청이 올 때마다 서명을 확인합니다.
// 그래서 게스트가 아무리 많아도 저장소가 필요 없고, 서버를 여러 대로 늘려도 비밀값만 같으면 됩니다.
package identity

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	KindGuest  = "guest"
	KindMember = "member"

	CookieName = "bm_session"
	// MaxAge가 지나면 토큰을 받지 않습니다. /api/me를 부를 때마다 다시 발급하므로 자주 오는 게스트는 만료되지 않습니다.
	MaxAge = 180 * 24 * time.Hour

	tokenVersion = "v1"
	// 다른 서버와 시계가 조금 어긋나도 받아줍니다.
	clockSkew = 5 * time.Minute
)

// User는 플레이어 한 명입니다. 게스트도 계정도 같은 모양입니다.
type User struct {
	ID   string `json:"id"` // 게스트는 g_, 계정은 m_로 시작합니다. 기록은 이 값으로 남깁니다.
	Kind string `json:"kind"`
	Name string `json:"name,omitempty"` // 계정만. 게스트 이름은 브라우저가 화면 언어로 만듭니다.
	Tag  string `json:"tag"`            // id에서 계산한 네 자리 숫자 ("게스트 4821")
}

func (u User) IsMember() bool { return u.Kind == KindMember }

// payload는 토큰에 담는 내용입니다. 이름처럼 바뀔 수 있는 값은 넣지 않습니다.
type payload struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	IssuedAt int64  `json:"iat"`
}

// Issuer는 세션 토큰을 발급하고 확인합니다.
type Issuer struct {
	secret []byte
	now    func() time.Time // 테스트에서 시간을 바꾸려고 둡니다
}

func NewIssuer(secret []byte) *Issuer {
	return &Issuer{secret: secret, now: time.Now}
}

// NewGuest는 새 게스트를 만듭니다. 어디에도 저장하지 않습니다.
func (is *Issuer) NewGuest() (User, error) {
	b := make([]byte, 10)
	if _, err := rand.Read(b); err != nil {
		return User{}, err
	}
	id := "g_" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(b))
	return User{ID: id, Kind: KindGuest, Tag: tagOf(id)}, nil
}

// tagOf는 id에서 네 자리 숫자를 만듭니다. 같은 id면 늘 같은 숫자입니다.
func tagOf(id string) string {
	sum := sha256.Sum256([]byte(id))
	return fmt.Sprintf("%04d", binary.BigEndian.Uint32(sum[:4])%10000)
}

// Sign은 u의 토큰을 만듭니다: v1.<내용>.<서명>
func (is *Issuer) Sign(u User) string {
	data, _ := json.Marshal(payload{ID: u.ID, Kind: u.Kind, IssuedAt: is.now().Unix()})
	body := tokenVersion + "." + base64.RawURLEncoding.EncodeToString(data)
	return body + "." + base64.RawURLEncoding.EncodeToString(is.mac(body))
}

func (is *Issuer) mac(body string) []byte {
	m := hmac.New(sha256.New, is.secret)
	m.Write([]byte(body))
	return m.Sum(nil)
}

// Verify는 토큰을 확인합니다. 서명이 틀리거나, 만료됐거나, 모양이 이상하면 false입니다.
func (is *Issuer) Verify(token string) (User, bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != tokenVersion {
		return User{}, false
	}
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	// 서명은 내용을 읽기 전에 확인합니다. 서명이 맞아야 내용을 믿을 수 있습니다.
	if err != nil || !hmac.Equal(sig, is.mac(parts[0]+"."+parts[1])) {
		return User{}, false
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return User{}, false
	}
	var p payload
	if err := json.Unmarshal(data, &p); err != nil {
		return User{}, false
	}
	issued := time.Unix(p.IssuedAt, 0)
	now := is.now()
	if now.Sub(issued) > MaxAge || issued.Sub(now) > clockSkew {
		return User{}, false
	}
	switch {
	case p.Kind == KindGuest && strings.HasPrefix(p.ID, "g_"):
	case p.Kind == KindMember && strings.HasPrefix(p.ID, "m_"):
		// TODO: 로그인을 붙이면 저장소에서 이름을 읽고, 탈퇴·강제 만료된 계정은 거절합니다.
	default:
		return User{}, false
	}
	return User{ID: p.ID, Kind: p.Kind, Tag: tagOf(p.ID)}, true
}

// FromRequest는 요청의 세션 쿠키에서 신원을 읽습니다.
func (is *Issuer) FromRequest(r *http.Request) (User, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil {
		return User{}, false
	}
	return is.Verify(c.Value)
}

// SetCookie는 u의 토큰을 새로 발급해 쿠키로 보냅니다.
func (is *Issuer) SetCookie(w http.ResponseWriter, r *http.Request, u User) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    is.Sign(u),
		Path:     "/",
		MaxAge:   int(MaxAge / time.Second),
		HttpOnly: true, // 페이지 스크립트(와 그 안의 게임 코드)가 읽지 못하게
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
}

// GCP 부하 분산기 뒤에서는 서버까지 HTTP로 오므로 X-Forwarded-Proto를 봅니다.
func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

// HandleMe는 GET /api/me 입니다. 쿠키가 없거나 깨졌으면 새 게스트를 발급하고, 지금 신원을 돌려줍니다.
// 쿠키는 매번 다시 발급해 만료를 늦춥니다.
func (is *Issuer) HandleMe(w http.ResponseWriter, r *http.Request) {
	u, ok := is.FromRequest(r)
	if !ok {
		var err error
		if u, err = is.NewGuest(); err != nil {
			http.Error(w, "게스트를 만들지 못했습니다", http.StatusInternalServerError)
			return
		}
	}
	is.SetCookie(w, r, u)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(u)
}

// RequireMember는 계정만 통과시킵니다. 업로드처럼 게스트가 하면 안 되는 요청에 씌웁니다.
//   - 세션이 없으면 401
//   - 게스트면 403 {"error":"member only"}
func (is *Issuer) RequireMember(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u, ok := is.FromRequest(r)
		if !ok {
			writeError(w, http.StatusUnauthorized, "no session")
			return
		}
		if !u.IsMember() {
			writeError(w, http.StatusForbidden, "member only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeError(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
