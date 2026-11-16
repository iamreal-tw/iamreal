package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
)

// maxBody is the largest request body read. A record is about 20 KB, almost
// all of it the proof.
const maxBody = 64 << 10

// readObject reads a request body that must be one JSON object whose
// members are exactly keys, each once, each a string. It returns the values
// by key. Anything else is an error: another key, a key twice, a key in
// another case, a value that is not a string, or anything after the object.
//
// encoding/json's Unmarshal into a struct is not strict enough: it matches
// keys without regard to case and takes the last of two equal keys
// (ADR-0014).
func readObject(body io.Reader, keys ...string) (map[string]string, error) {
	dec := json.NewDecoder(io.LimitReader(body, maxBody+1))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, errors.New("not a JSON object")
	}
	values := map[string]string{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		if !slices.Contains(keys, key) {
			return nil, fmt.Errorf("unknown key %q", key)
		}
		if _, seen := values[key]; seen {
			return nil, fmt.Errorf("key %q twice", key)
		}
		tok, err = dec.Token()
		if err != nil {
			return nil, err
		}
		value, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("%s: not a string", key)
		}
		values[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, errors.New("not a JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("something after the object")
	}
	if dec.InputOffset() > maxBody {
		return nil, errors.New("body too long")
	}
	for _, k := range keys {
		if _, ok := values[k]; !ok {
			return nil, fmt.Errorf("missing key %q", k)
		}
	}
	return values, nil
}
