package verifier

import (
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// jsonValue is one member value of a flat JSON object: a string (decoded), or
// any other scalar as its raw token.
type jsonValue struct {
	isString bool
	text     string
}

type jsonMember struct {
	key   string
	value jsonValue
}

// parseFlatObject reads one JSON object whose values are scalars, with
// optional whitespace around it. It is the "parse it in any way" step of
// checking a line (spec/record.md): it accepts more than the template does,
// on purpose, because the byte comparison with the rewritten line is what
// decides. Members are returned in order, duplicates included.
func parseFlatObject(b []byte) ([]jsonMember, error) {
	p := &jsonParser{b: b}
	p.space()
	if !p.eat('{') {
		return nil, errors.New("not a JSON object")
	}
	var members []jsonMember
	p.space()
	if p.eat('}') {
		return members, p.end()
	}
	for {
		p.space()
		key, err := p.str()
		if err != nil {
			return nil, err
		}
		p.space()
		if !p.eat(':') {
			return nil, errors.New("expected `:`")
		}
		p.space()
		v, err := p.scalar()
		if err != nil {
			return nil, err
		}
		members = append(members, jsonMember{key, v})
		p.space()
		if p.eat(',') {
			continue
		}
		if p.eat('}') {
			return members, p.end()
		}
		return nil, errors.New("expected `,` or `}`")
	}
}

type jsonParser struct {
	b []byte
	i int
}

func (p *jsonParser) space() {
	for p.i < len(p.b) && (p.b[p.i] == ' ' || p.b[p.i] == '\t' || p.b[p.i] == '\n' || p.b[p.i] == '\r') {
		p.i++
	}
}

func (p *jsonParser) eat(c byte) bool {
	if p.i < len(p.b) && p.b[p.i] == c {
		p.i++
		return true
	}
	return false
}

func (p *jsonParser) end() error {
	p.space()
	if p.i != len(p.b) {
		return errors.New("bytes after the object")
	}
	return nil
}

func (p *jsonParser) scalar() (jsonValue, error) {
	if p.i >= len(p.b) {
		return jsonValue{}, errors.New("missing value")
	}
	if p.b[p.i] == '"' {
		s, err := p.str()
		return jsonValue{isString: true, text: s}, err
	}
	start := p.i
	for p.i < len(p.b) {
		c := p.b[p.i]
		if c == ',' || c == '}' || c == ' ' || c == '\t' || c == '\n' || c == '\r' {
			break
		}
		if c == '{' || c == '[' || c == '"' {
			return jsonValue{}, errors.New("value is not a scalar")
		}
		p.i++
	}
	if p.i == start {
		return jsonValue{}, errors.New("missing value")
	}
	return jsonValue{text: string(p.b[start:p.i])}, nil
}

func (p *jsonParser) str() (string, error) {
	if !p.eat('"') {
		return "", errors.New("expected a string")
	}
	var out []byte
	for {
		if p.i >= len(p.b) {
			return "", errors.New("unterminated string")
		}
		c := p.b[p.i]
		switch {
		case c == '"':
			p.i++
			if !utf8.Valid(out) {
				return "", errors.New("string is not valid UTF-8")
			}
			return string(out), nil
		case c < 0x20:
			return "", errors.New("control character in a string")
		case c == '\\':
			if p.i+1 >= len(p.b) {
				return "", errors.New("unterminated escape")
			}
			e := p.b[p.i+1]
			p.i += 2
			switch e {
			case '"', '\\', '/':
				out = append(out, e)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'u':
				r, err := p.hex4()
				if err != nil {
					return "", err
				}
				if utf16.IsSurrogate(r) {
					if p.i+1 < len(p.b) && p.b[p.i] == '\\' && p.b[p.i+1] == 'u' {
						p.i += 2
						r2, err := p.hex4()
						if err != nil {
							return "", err
						}
						r = utf16.DecodeRune(r, r2)
					} else {
						r = utf8.RuneError
					}
				}
				out = utf8.AppendRune(out, r)
			default:
				return "", errors.New("unknown escape")
			}
		default:
			out = append(out, c)
			p.i++
		}
	}
}

func (p *jsonParser) hex4() (rune, error) {
	if p.i+4 > len(p.b) {
		return 0, errors.New("short \\u escape")
	}
	v, err := strconv.ParseUint(string(p.b[p.i:p.i+4]), 16, 16)
	if err != nil {
		return 0, errors.New("bad \\u escape")
	}
	p.i += 4
	return rune(v), nil
}
