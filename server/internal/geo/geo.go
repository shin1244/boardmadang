// Package geo는 IP 주소로 나라를 알아냅니다. 운영자 화면의 나라별 방문 수(internal/stats)에만 씁니다.
//
// DB-IP의 IP to Country Lite(https://db-ip.com, CC BY 4.0)를 씁니다. 한 줄이 IP 범위 하나입니다: 처음,끝,나라 코드.
// 도커 이미지를 만들 때 그달 파일(.csv.gz)을 받아 넣고(Dockerfile), 서버는 켤 때 GEO_FILE을 한 번 읽어 메모리에 둡니다.
// 나라까지만 알 수 있고 도시는 모릅니다. VPN이나 해외 로밍이면 실제와 다를 수 있습니다.
//
// IP 주소는 나라를 찾는 데만 쓰고 어디에도 남기지 않습니다.
// 라이선스에 따라 나라별 수를 보여 주는 화면(운영자 화면)에 DB-IP로 가는 링크를 둡니다.
package geo

import (
	"bufio"
	"cmp"
	"compress/gzip"
	"encoding/binary"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"os"
	"slices"
	"strings"
)

// key는 IP 주소를 큰 수 하나로 본 것입니다. IPv4는 IPv6 모양(::ffff:a.b.c.d)으로 바꿔 IPv6와 한 줄로 세웁니다.
type key struct{ hi, lo uint64 }

func keyOf(a netip.Addr) key {
	b := a.As16()
	return key{binary.BigEndian.Uint64(b[:8]), binary.BigEndian.Uint64(b[8:])}
}

func (k key) compare(o key) int {
	if c := cmp.Compare(k.hi, o.hi); c != 0 {
		return c
	}
	return cmp.Compare(k.lo, o.lo)
}

// next는 k 다음 주소입니다. k가 가장 큰 주소면 false입니다.
func (k key) next() (key, bool) {
	if k.lo != math.MaxUint64 {
		return key{k.hi, k.lo + 1}, true
	}
	if k.hi != math.MaxUint64 {
		return key{k.hi + 1, 0}, true
	}
	return k, false
}

// DB는 주소 공간을 나눈 칸들입니다. 칸 i는 starts[i]부터 다음 칸의 처음 바로 앞까지이고, 그 나라가 countries[i]입니다.
// 끝 주소를 따로 두지 않아 메모리를 아낍니다 (운영 VM이 작습니다). 범위가 없는 곳은 나라가 빈 칸으로 채웁니다.
// 여러 고루틴에서 같이 읽어도 됩니다.
type DB struct {
	starts    []key
	countries [][2]byte // {0, 0}이면 모름
}

// Open은 DB-IP의 CSV 파일(.csv 또는 .csv.gz)을 읽습니다.
func Open(file string) (*DB, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var r io.Reader = bufio.NewReaderSize(f, 1<<16)
	if strings.HasSuffix(file, ".gz") {
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		r = gz
	}
	db, err := Read(r)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", file, err)
	}
	return db, nil
}

// span은 CSV 한 줄입니다.
type span struct {
	first, last key
	country     [2]byte
}

// Read는 CSV를 읽습니다. 나라 코드가 ZZ(예약된 주소 등)인 범위는 넣지 않으므로 그 주소는 나라를 모르는 것으로 나옵니다.
func Read(r io.Reader) (*DB, error) {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.ReuseRecord = true
	var spans []span
	for n := 1; ; n++ {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(rec) < 3 {
			return nil, fmt.Errorf("%d번째 줄: 칸이 %d개입니다", n, len(rec))
		}
		first, err1 := netip.ParseAddr(strings.TrimSpace(rec[0]))
		last, err2 := netip.ParseAddr(strings.TrimSpace(rec[1]))
		if err := errors.Join(err1, err2); err != nil {
			return nil, fmt.Errorf("%d번째 줄: %w", n, err)
		}
		cc := strings.TrimSpace(rec[2])
		s := span{first: keyOf(first), last: keyOf(last)}
		if first.Is4() != last.Is4() || s.last.compare(s.first) < 0 || !validCountry(cc) {
			return nil, fmt.Errorf("%d번째 줄: %q", n, strings.Join(rec, ","))
		}
		if cc == "ZZ" {
			continue
		}
		s.country = [2]byte{cc[0], cc[1]}
		spans = append(spans, s)
	}
	if len(spans) == 0 {
		return nil, errors.New("IP 범위가 하나도 없습니다")
	}
	slices.SortFunc(spans, func(a, b span) int { return a.first.compare(b.first) })

	db := &DB{}
	add := func(start key, country [2]byte) {
		if n := len(db.countries); n > 0 && db.countries[n-1] == country {
			return // 붙어 있는 같은 나라는 한 칸
		}
		db.starts = append(db.starts, start)
		db.countries = append(db.countries, country)
	}
	var end key // 지금까지 덮은 마지막 주소
	covered := false
	for _, s := range spans {
		if covered {
			after, ok := end.next()
			if !ok {
				break // 주소 공간 끝까지 덮었음
			}
			if s.first.compare(after) > 0 {
				add(after, [2]byte{}) // 범위 사이의 빈 곳
			}
			if s.last.compare(end) <= 0 {
				continue // 앞 범위 안에 들어 있음
			}
			if s.first.compare(after) < 0 {
				s.first = after // 앞 범위와 겹친 부분은 앞 범위를 따릅니다
			}
		}
		add(s.first, s.country)
		end, covered = s.last, true
	}
	if after, ok := end.next(); ok {
		add(after, [2]byte{})
	}
	db.starts, db.countries = slices.Clip(db.starts), slices.Clip(db.countries)
	return db, nil
}

func validCountry(cc string) bool {
	return len(cc) == 2 && cc[0] >= 'A' && cc[0] <= 'Z' && cc[1] >= 'A' && cc[1] <= 'Z'
}

// Len은 칸의 수입니다.
func (db *DB) Len() int {
	if db == nil {
		return 0
	}
	return len(db.starts)
}

// Country는 ip의 나라 코드(ISO 3166-1의 대문자 두 글자, 한국은 KR)입니다. 모르면 ""입니다.
// db가 nil이어도 됩니다 (나라 파일이 없을 때).
func (db *DB) Country(ip netip.Addr) string {
	if db == nil || !ip.IsValid() {
		return ""
	}
	k := keyOf(ip.WithZone(""))
	// k보다 처음 주소가 큰 첫 칸의 바로 앞 칸
	i, _ := slices.BinarySearchFunc(db.starts, k, func(s, k key) int {
		if s.compare(k) <= 0 {
			return -1
		}
		return 1
	})
	if i == 0 || db.countries[i-1] == [2]byte{} {
		return ""
	}
	return string(db.countries[i-1][:])
}

// ClientIP는 요청을 보낸 사람의 IP 주소입니다.
//
// 운영에서는 Caddy가 앞에서 받아 넘기므로 r.RemoteAddr는 Caddy의 주소(도커 사설망)이고, 실제 주소는 X-Forwarded-For에 있습니다.
// 그래서 요청이 사설망이나 이 컴퓨터에서 왔을 때만 그 헤더의 마지막 값(바로 앞의 프록시가 본 주소)을 씁니다.
// 인터넷에서 바로 온 요청의 헤더는 누구나 꾸밀 수 있기 때문입니다.
// Caddy는 믿는 프록시가 따로 없으면 들어온 X-Forwarded-For를 버리고 자기가 본 주소만 넣습니다.
func ClientIP(r *http.Request) netip.Addr {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}
	}
	remote = remote.Unmap()
	if !remote.IsLoopback() && !remote.IsPrivate() {
		return remote
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return remote
	}
	parts := strings.Split(values[len(values)-1], ",")
	if fwd, err := netip.ParseAddr(strings.TrimSpace(parts[len(parts)-1])); err == nil {
		return fwd.Unmap()
	}
	return remote
}
