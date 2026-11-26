package geo

import (
	"compress/gzip"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// DB-IP의 country lite CSV와 같은 모양. 일부러 순서를 섞고, 빈 곳, ZZ, 겹침, 따옴표, IPv6를 넣습니다
const sample = `1.0.4.0,1.0.7.255,AU
1.0.0.0,1.0.0.255,AU
1.0.1.0,1.0.3.255,CN
"1.0.8.0","1.0.15.255","KR"
1.0.16.0,1.0.31.255,KR
1.0.32.0,1.0.63.255,ZZ
1.0.64.0,1.0.64.255,JP
1.0.64.10,1.0.64.20,US
1.0.64.200,1.0.65.255,CN
2001:e60::,2001:e6f:ffff:ffff:ffff:ffff:ffff:ffff,KR
2001:4860::,2001:4860:ffff:ffff:ffff:ffff:ffff:ffff,US
`

func TestCountry(t *testing.T) {
	db, err := Read(strings.NewReader(sample))
	if err != nil {
		t.Fatal(err)
	}
	for ip, want := range map[string]string{
		"1.0.0.0":         "AU",
		"1.0.0.255":       "AU",
		"1.0.1.0":         "CN",
		"1.0.3.255":       "CN",
		"1.0.5.5":         "AU",
		"1.0.8.0":         "KR", // 따옴표
		"1.0.20.1":        "KR", // 붙어 있는 같은 나라
		"1.0.40.1":        "",   // ZZ
		"1.0.64.15":       "JP", // 앞 범위 안에 들어 있는 범위는 앞 범위를 따름
		"1.0.64.250":      "JP", // 겹친 부분은 앞 범위
		"1.0.65.1":        "CN", // 겹치지 않은 나머지
		"1.0.66.0":        "",   // 마지막 범위 뒤
		"0.255.255.255":   "",   // 첫 범위 앞
		"::ffff:1.0.1.1":  "CN", // IPv6 모양의 IPv4
		"2001:e60::1":     "KR",
		"2001:4860::8888": "US",
		"2001:4861::1":    "",
		"fe80::1%eth0":    "",
	} {
		if got := db.Country(netip.MustParseAddr(ip)); got != want {
			t.Errorf("Country(%s) = %q, want %q", ip, got, want)
		}
	}
	if got := db.Country(netip.Addr{}); got != "" {
		t.Errorf("Country(zero) = %q", got)
	}
	var none *DB
	if got := none.Country(netip.MustParseAddr("1.0.0.1")); got != "" || none.Len() != 0 {
		t.Errorf("nil DB = %q", got)
	}
}

// 붙어 있는 같은 나라는 한 칸으로 합칩니다
func TestMerge(t *testing.T) {
	db, err := Read(strings.NewReader("1.0.0.0,1.0.0.255,KR\n1.0.1.0,1.0.1.255,KR\n1.0.2.0,1.0.2.255,KR\n"))
	if err != nil {
		t.Fatal(err)
	}
	if db.Len() != 2 { // KR 한 칸 + 뒤의 빈 칸
		t.Errorf("Len = %d, want 2", db.Len())
	}
}

func TestReadErrors(t *testing.T) {
	for name, body := range map[string]string{
		"비었음":    "",
		"ZZ만":    "1.0.0.0,1.0.0.255,ZZ\n",
		"칸이 모자람": "1.0.0.0,1.0.0.255\n",
		"주소가 아님": "1.0.0.0,nope,KR\n",
		"나라 코드":  "1.0.0.0,1.0.0.255,kor\n",
		"거꾸로":    "1.0.0.255,1.0.0.0,KR\n",
		"v4와 v6": "1.0.0.0,2001::1,KR\n",
		"따옴표 깨짐": "\"1.0.0.0,1.0.0.255,KR\n",
	} {
		if _, err := Read(strings.NewReader(body)); err == nil {
			t.Errorf("%s: 오류가 없습니다", name)
		}
	}
}

func TestOpenGzip(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "dbip-country-lite.csv.gz")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	gz := gzip.NewWriter(f)
	gz.Write([]byte(sample))
	gz.Close()
	f.Close()
	db, err := Open(file)
	if err != nil {
		t.Fatal(err)
	}
	if got := db.Country(netip.MustParseAddr("1.0.8.1")); got != "KR" {
		t.Errorf("Country = %q", got)
	}
	plain := filepath.Join(dir, "plain.csv")
	os.WriteFile(plain, []byte(sample), 0o644)
	if db, err := Open(plain); err != nil || db.Country(netip.MustParseAddr("1.0.1.1")) != "CN" {
		t.Errorf("csv: %v", err)
	}
	if _, err := Open(filepath.Join(dir, "없음.csv.gz")); err == nil {
		t.Error("없는 파일인데 열렸습니다")
	}
}

func TestClientIP(t *testing.T) {
	for _, c := range []struct {
		name, remote string
		forwarded    []string
		want         string
	}{
		{"인터넷에서 바로", "203.0.113.5:1234", nil, "203.0.113.5"},
		{"인터넷에서 바로 온 헤더는 믿지 않음", "203.0.113.5:1234", []string{"1.2.3.4"}, "203.0.113.5"},
		{"Caddy (도커 사설망)", "172.18.0.3:5555", []string{"1.2.3.4"}, "1.2.3.4"},
		{"Caddy (이 컴퓨터)", "127.0.0.1:5555", []string{"1.2.3.4"}, "1.2.3.4"},
		{"여러 프록시면 마지막", "172.18.0.3:5555", []string{"9.9.9.9, 1.2.3.4"}, "1.2.3.4"},
		{"헤더가 여러 줄이면 마지막 줄", "172.18.0.3:5555", []string{"9.9.9.9", "5.6.7.8"}, "5.6.7.8"},
		{"IPv6", "[::1]:5555", []string{"2001:e60::1"}, "2001:e60::1"},
		{"IPv6 모양의 IPv4", "[::ffff:172.18.0.3]:5555", []string{"::ffff:1.2.3.4"}, "1.2.3.4"},
		{"헤더가 없으면 그대로", "172.18.0.3:5555", nil, "172.18.0.3"},
		{"헤더가 깨졌으면 그대로", "172.18.0.3:5555", []string{"nope"}, "172.18.0.3"},
		{"포트 없음", "203.0.113.5", nil, "203.0.113.5"},
	} {
		r := httptest.NewRequest("GET", "/api/me", nil)
		r.RemoteAddr = c.remote
		for _, v := range c.forwarded {
			r.Header.Add("X-Forwarded-For", v)
		}
		if got := ClientIP(r); got.String() != c.want {
			t.Errorf("%s: ClientIP = %s, want %s", c.name, got, c.want)
		}
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "@"
	if got := ClientIP(r); got.IsValid() {
		t.Errorf("깨진 RemoteAddr: %s", got)
	}
}
