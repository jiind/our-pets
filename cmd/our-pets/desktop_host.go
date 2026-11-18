package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
)

const desktopPort = 19378

type desktopHost struct {
	URL      string `json:"url"`
	LocalURL string `json:"localUrl"`
	Invite   string `json:"invite"`
}

// 데스크톱 앱이 관리하는 서버에 전용 데이터와 로컬망 범위를 적용한다.
func desktopConfig(directory string) (desktopHost, error) {
	address, subnet, err := localNetwork()
	if err != nil {
		return desktopHost{}, err
	}
	invite, err := desktopInvite(directory)
	if err != nil {
		return desktopHost{}, err
	}
	for key, value := range map[string]string{
		"OURPETS_BIND":          fmt.Sprintf("0.0.0.0:%d", desktopPort),
		"OURPETS_DATA":          directory,
		"OURPETS_INVITE":        invite,
		"OURPETS_ALLOWED_CIDRS": "127.0.0.0/8," + subnet.String(),
	} {
		if err := os.Setenv(key, value); err != nil {
			return desktopHost{}, err
		}
	}
	return desktopHost{
		URL:      fmt.Sprintf("http://%s:%d", address, desktopPort),
		LocalURL: fmt.Sprintf("http://127.0.0.1:%d", desktopPort),
		Invite:   invite,
	}, nil
}

// 같은 앱 데이터에서 서버를 다시 열 때 기존 초대 링크를 유지한다.
func desktopInvite(directory string) (string, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "invite")
	value, err := os.ReadFile(path)
	if err == nil {
		invite := strings.TrimSpace(string(value))
		if decoded, err := hex.DecodeString(invite); err == nil && len(decoded) == 24 {
			return invite, nil
		}
		return "", errors.New("desktop invitation file is invalid")
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	var secret [24]byte
	if _, err := rand.Read(secret[:]); err != nil {
		return "", err
	}
	invite := hex.EncodeToString(secret[:])
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return "", err
	}
	_, writeErr := io.WriteString(file, invite+"\n")
	if err := errors.Join(writeErr, file.Close()); err != nil {
		_ = os.Remove(path)
		return "", err
	}
	return invite, nil
}

// 사설 IPv4 인터페이스를 고르고, OS가 기본 경로에 고른 주소를 우선한다.
func localNetwork() (netip.Addr, netip.Prefix, error) {
	var preferred netip.Addr
	if route, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(192, 0, 2, 1), Port: 9}); err == nil {
		preferred, _ = netip.AddrFromSlice(route.LocalAddr().(*net.UDPAddr).IP)
		preferred = preferred.Unmap()
		_ = route.Close()
	}
	interfaces, err := net.Interfaces()
	if err != nil {
		return netip.Addr{}, netip.Prefix{}, err
	}
	var address netip.Addr
	var subnet netip.Prefix
	for _, device := range interfaces {
		if device.Flags&net.FlagUp == 0 || device.Flags&(net.FlagLoopback|net.FlagPointToPoint) != 0 {
			continue
		}
		addrs, _ := device.Addrs()
		for _, candidate := range addrs {
			prefix, err := netip.ParsePrefix(candidate.String())
			if err != nil || !prefix.Addr().Is4() || !prefix.Addr().IsPrivate() {
				continue
			}
			ip := prefix.Addr()
			for _, private := range []netip.Prefix{
				netip.MustParsePrefix("10.0.0.0/8"),
				netip.MustParsePrefix("172.16.0.0/12"),
				netip.MustParsePrefix("192.168.0.0/16"),
			} {
				if private.Contains(ip) && prefix.Bits() < private.Bits() {
					prefix = private
				}
			}
			if ip == preferred {
				return ip, prefix.Masked(), nil
			}
			if !address.IsValid() {
				address, subnet = ip, prefix.Masked()
			}
		}
	}
	if !address.IsValid() {
		return netip.Addr{}, netip.Prefix{}, errors.New("no private IPv4 network")
	}
	return address, subnet, nil
}

// 호스트 시작 결과는 데스크톱 앱에 연결된 파이프로 전달한다.
func (host desktopHost) ready() error {
	return json.NewEncoder(os.Stdout).Encode(host)
}
