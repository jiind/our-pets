package pets

// builtinSelection은 예약된 기본 캐릭터 선택과 사용자 업로드 ID를 구분한다.
func builtinSelection(selection string) (string, bool) {
	switch selection {
	case "default", "builtin:cat":
		return "cat", true
	case "builtin:dog":
		return "dog", true
	case "builtin:gopher":
		return "gopher", true
	case "builtin:ferris":
		return "ferris", true
	default:
		return "", false
	}
}
