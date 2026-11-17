package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"

	"github.com/iamreal-tw/iamreal/verifier"
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
	values, _, err := readObjectWithList(body, "", keys...)
	return values, err
}

// readObjectWithList is readObject, except that one more member, listKey,
// is required and may be any JSON value: it is returned as it came, for the
// caller to read (readAccounts). With listKey "", it is readObject.
func readObjectWithList(body io.Reader, listKey string, keys ...string) (map[string]string, json.RawMessage, error) {
	var list json.RawMessage
	dec := json.NewDecoder(io.LimitReader(body, maxBody+1))
	tok, err := dec.Token()
	if err != nil || tok != json.Delim('{') {
		return nil, nil, errors.New("not a JSON object")
	}
	values := map[string]string{}
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, nil, err
		}
		key, _ := tok.(string)
		if listKey != "" && key == listKey {
			if list != nil {
				return nil, nil, fmt.Errorf("key %q twice", key)
			}
			if err := dec.Decode(&list); err != nil {
				return nil, nil, err
			}
			continue
		}
		if !slices.Contains(keys, key) {
			return nil, nil, fmt.Errorf("unknown key %q", key)
		}
		if _, seen := values[key]; seen {
			return nil, nil, fmt.Errorf("key %q twice", key)
		}
		tok, err = dec.Token()
		if err != nil {
			return nil, nil, err
		}
		value, ok := tok.(string)
		if !ok {
			return nil, nil, fmt.Errorf("%s: not a string", key)
		}
		values[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, nil, errors.New("not a JSON object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, nil, errors.New("something after the object")
	}
	if dec.InputOffset() > maxBody {
		return nil, nil, errors.New("body too long")
	}
	for _, k := range keys {
		if _, ok := values[k]; !ok {
			return nil, nil, fmt.Errorf("missing key %q", k)
		}
	}
	if listKey != "" && list == nil {
		return nil, nil, fmt.Errorf("missing key %q", listKey)
	}
	return values, list, nil
}

// readAccounts reads the accounts of a submitted record, in the order they
// came. ok is true if the value is a list whose every entry is an object
// with exactly the keys platform and username, each once, each a string
// (docs/api/card-proof.md: only such a list can be `platform`). Whether the
// platforms are in the table, in order and not repeated, and whether the
// usernames are in their formats, is the record's format
// (verifier.CheckAccounts); nothing is sorted or filled in here.
func readAccounts(raw json.RawMessage) (accounts []verifier.Account, ok bool) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil, false
	}
	accounts = []verifier.Account{}
	for dec.More() {
		if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
			return nil, false
		}
		values := map[string]string{}
		for dec.More() {
			tok, err := dec.Token()
			if err != nil {
				return nil, false
			}
			key, _ := tok.(string)
			if key != "platform" && key != "username" {
				return nil, false
			}
			if _, seen := values[key]; seen {
				return nil, false
			}
			tok, err = dec.Token()
			if err != nil {
				return nil, false
			}
			value, isString := tok.(string)
			if !isString {
				return nil, false
			}
			values[key] = value
		}
		if tok, err := dec.Token(); err != nil || tok != json.Delim('}') || len(values) != 2 {
			return nil, false
		}
		accounts = append(accounts, verifier.Account{Platform: values["platform"], Username: values["username"]})
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim(']') {
		return nil, false
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, false
	}
	return accounts, true
}
