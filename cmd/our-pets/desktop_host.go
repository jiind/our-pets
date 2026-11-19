package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"

	"github.com/jiind/our-pets/internal/identity"
	"github.com/jiind/our-pets/internal/model"
	"github.com/jiind/our-pets/internal/pets"
	"github.com/jiind/our-pets/internal/server"
)

const desktopPort = 19378

type desktopHost struct {
	URL      string          `json:"url,omitempty"`
	LocalURL string          `json:"localUrl"`
	Invite   string          `json:"invite,omitempty"`
	Session  *identity.Login `json:"session,omitempty"`
	Error    bool            `json:"error,omitempty"`
}

type desktopRequest struct {
	Action      string `json:"action"`
	DisplayName string `json:"displayName"`
	DeviceID    string `json:"deviceId"`
}

type desktopLAN struct {
	server   *http.Server
	listener net.Listener
	cancel   context.CancelFunc
}

func (lan *desktopLAN) close() {
	lan.cancel()
	_ = lan.server.Close()
	_ = lan.listener.Close()
}

// 데스크톱 앱이 관리하는 서버에 전용 데이터와 로컬망 범위를 적용한다.
func desktopConfig(directory string) (desktopHost, error) {
	invite, err := desktopInvite(directory)
	if err != nil {
		return desktopHost{}, err
	}
	for key, value := range map[string]string{
		"OURPETS_BIND":          fmt.Sprintf("127.0.0.1:%d", desktopPort),
		"OURPETS_DATA":          directory,
		"OURPETS_INVITE":        invite,
		"OURPETS_ALLOWED_CIDRS": "127.0.0.0/8",
	} {
		if err := os.Setenv(key, value); err != nil {
			return desktopHost{}, err
		}
	}
	return desktopHost{
		LocalURL: fmt.Sprintf("http://127.0.0.1:%d", desktopPort),
	}, nil
}

// 같은 앱 데이터에서 서버를 다시 열 때 기존 초대 링크를 유지한다.
func desktopInvite(directory string) (string, error) {
	return desktopSecret(directory, "invite")
}

// 가입 코드와 이 PC의 자동 로그인 비밀번호는 각각 별도의 난수로 보관한다.
func desktopSecret(directory, name string) (string, error) {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, name)
	value, err := os.ReadFile(path)
	if err == nil {
		invite := strings.TrimSpace(string(value))
		if decoded, err := hex.DecodeString(invite); err == nil && len(decoded) == 24 {
			return invite, nil
		}
		return "", errors.New("desktop secret file is invalid")
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

// 데스크톱 전용 파이프에서만 자동 계정으로 로그인하고 첫 펫을 활성화한다.
func desktopSession(app *server.Server, request desktopRequest) (identity.Login, error) {
	secret, err := desktopSecret(app.Config.Directory, "local-account")
	if err != nil {
		return identity.Login{}, err
	}
	credentials := identity.Credentials{
		Username:    "local-" + identity.HashToken(secret)[:24],
		Password:    secret,
		DisplayName: request.DisplayName,
		Invite:      app.Config.Invite,
		DeviceID:    request.DeviceID,
		DeviceName:  "desktop",
	}
	login, err := app.Identity.Authenticate(credentials)
	if status, _ := model.Status(err); status == http.StatusUnauthorized {
		login, err = app.Identity.Register(credentials)
	}
	if err == nil && !login.Principal.PetRegistered {
		var pet model.Pet
		pet, err = app.Pets.Register(login.Principal, pets.Registration{DesignID: "default"})
		login.Principal.PetRegistered = pet.Registered
	}
	return login, err
}

// 공유는 별도의 LAN 주소에서만 열고 실행 중인 저장소와 펫 연결을 재사용한다.
func openDesktopLAN(app *server.Server, host desktopHost) (desktopHost, *desktopLAN, error) {
	address, subnet, err := localNetwork()
	if err != nil {
		return desktopHost{}, nil, err
	}
	listener, err := net.Listen("tcp4", fmt.Sprintf("%s:%d", address, desktopPort))
	if err != nil {
		return desktopHost{}, nil, err
	}
	host.URL = "http://" + listener.Addr().String()
	host.Invite = app.Config.Invite
	return host, serveDesktopLAN(listener, app.HandlerForCIDRs([]netip.Prefix{subnet})), nil
}

// LAN 요청과 웹소켓에 전용 컨텍스트를 적용해 로컬 펫에 영향 없이 공유를 종료한다.
func serveDesktopLAN(listener net.Listener, handler http.Handler) *desktopLAN {
	ctx, cancel := context.WithCancel(context.Background())
	shared := newHTTPServer(listener.Addr().String(), handler)
	shared.BaseContext = func(net.Listener) context.Context { return ctx }
	go func() { _ = shared.Serve(listener) }()
	return &desktopLAN{server: shared, listener: listener, cancel: cancel}
}

// 앱이 닫으면 파이프가 닫히고, 공유 요청 전에는 LAN 리스너를 열지 않는다.
func controlDesktop(app *server.Server, local desktopHost, shared desktopHost, lan *desktopLAN, stop func()) {
	defer stop()
	defer func() {
		if lan != nil {
			lan.close()
		}
	}()
	commands := bufio.NewScanner(os.Stdin)
	replies := json.NewEncoder(os.Stdout)
	for commands.Scan() {
		var request desktopRequest
		result := local
		err := json.Unmarshal(commands.Bytes(), &request)
		if err == nil {
			switch request.Action {
			case "open":
				var login identity.Login
				login, err = desktopSession(app, request)
				result.Session = &login
			case "share":
				if lan == nil {
					shared, lan, err = openDesktopLAN(app, local)
				}
				result = shared
			case "unshare":
				if lan != nil {
					lan.close()
					lan = nil
				}
				shared = local
			default:
				err = errors.New("unknown desktop command")
			}
		}
		if err != nil {
			result = desktopHost{Error: true}
		}
		if replies.Encode(result) != nil {
			return
		}
	}
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
