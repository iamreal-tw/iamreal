package verifier

import (
	"errors"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// jsonValue is one member value of a record's JSON object: a string
// (decoded), any other scalar as its raw token, or a list whose elements are
// flat objects (the account list).
type jsonValue struct {
	isString bool
	text     string
	isList   bool
	list     [][]jsonMember // the members of each element, if isList
}

type jsonMember struct {
	key   string
	value jsonValue
}

// parseRecordObject reads one JSON object whose values are scalars or lists
// of flat objects (objects whose values are scalars), with optional
// whitespace around it. It is the "parse it in any way" step of checking a
// line (spec/record.md): it accepts more than the template does, on purpose,
// because the byte comparison with the rewritten line is what decides.
// Members are returned in order, duplicates included, at both levels.
func parseRecordObject(b []byte) ([]jsonMember, error) {
	p := &jsonParser{b: b}
	p.space()
	members, err := p.object(true)
	if err != nil {
		return nil, err
	}
	return members, p.end()
}

// object reads an object at the parser's position. Its values are scalars;
// if lists is true, they may also be lists of flat objects.
func (p *jsonParser) object(lists bool) ([]jsonMember, error) {
	if !p.eat('{') {
		return nil, errors.New("not a JSON object")
	}
	var members []jsonMember
	p.space()
	if p.eat('}') {
		return members, nil
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
		var v jsonValue
		if lists && p.i < len(p.b) && p.b[p.i] == '[' {
			v, err = p.list()
		} else {
			v, err = p.scalar()
		}
		if err != nil {
			return nil, err
		}
		members = append(members, jsonMember{key, v})
		p.space()
		if p.eat(',') {
			continue
		}
		if p.eat('}') {
			return members, nil
		}
		return nil, errors.New("expected `,` or `}`")
	}
}

// list reads a list whose elements are flat objects.
func (p *jsonParser) list() (jsonValue, error) {
	v := jsonValue{isList: true, list: [][]jsonMember{}}
	if !p.eat('[') {
		return v, errors.New("not a list")
	}
	p.space()
	if p.eat(']') {
		return v, nil
	}
	for {
		p.space()
		if p.i >= len(p.b) || p.b[p.i] != '{' {
			return v, errors.New("an element of the list is not an object")
		}
		members, err := p.object(false)
		if err != nil {
			return v, err
		}
		v.list = append(v.list, members)
		p.space()
		if p.eat(',') {
			continue
		}
		if p.eat(']') {
			return v, nil
		}
		return v, errors.New("expected `,` or `]`")
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
