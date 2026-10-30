package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// 0행 0열 클릭이 JSON을 거쳐도 사라지지 않아야 합니다.
func TestActionKeepsZeroCoordinates(t *testing.T) {
	data, err := json.Marshal(Relay{Type: TypeRelay, Action: Action{Kind: "click", Row: 0, Col: 0}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"row":0`) || !strings.Contains(string(data), `"col":0`) {
		t.Fatalf("zero coordinates dropped: %s", data)
	}
}

func TestPeekType(t *testing.T) {
	got, err := PeekType([]byte(`{"type":"action","action":{"kind":"click","row":1,"col":2}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got != TypeAction {
		t.Fatalf("PeekType = %q, want %q", got, TypeAction)
	}
}

func TestDrawResultHasNullWinner(t *testing.T) {
	data, _ := json.Marshal(Ended{Type: TypeEnded, Reason: ReasonDesync})
	if !strings.Contains(string(data), `"winner":null`) {
		t.Fatalf("draw should send winner:null, got %s", data)
	}
}
