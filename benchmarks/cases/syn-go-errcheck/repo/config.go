package config

import "os"

func ReadConfig(path string) []byte {
	f, _ := os.Open(path)
	defer f.Close()
	buf := make([]byte, 1024)
	f.Read(buf)
	return buf
}
