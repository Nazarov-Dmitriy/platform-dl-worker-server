package servercert

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Settings struct {
	Host string `json:"host"`
	Mode string `json:"mode"`
}
type View struct {
	Host        string    `json:"host"`
	Mode        string    `json:"mode"`
	ExpiresAt   time.Time `json:"expiresAt"`
	DownloadURL string    `json:"downloadUrl"`
}
type Manager struct {
	mu          sync.RWMutex
	dir         string
	settings    Settings
	certificate *tls.Certificate
	publicCA    []byte
}

func ValidHost(host string) bool {
	if net.ParseIP(host) != nil {
		return true
	}
	if host == "" || len(host) > 253 {
		return false
	}
	for _, label := range strings.Split(host, ".") {
		if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for _, c := range label {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}
func New(dir, host string) (*Manager, error) {
	m := &Manager{dir: dir, settings: Settings{Host: host, Mode: "auto"}}
	if raw, e := os.ReadFile(filepath.Join(dir, "connection.json")); e == nil {
		if e = json.Unmarshal(raw, &m.settings); e != nil {
			return nil, errors.New("invalid saved connection configuration")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	if !ValidHost(m.settings.Host) {
		return nil, errors.New("set DISPATCHER_HOST to your IP address or DNS name")
	}
	if m.settings.Mode != "auto" && m.settings.Mode != "manual" {
		return nil, errors.New("invalid certificate mode")
	}
	if e := m.refreshLocked(); e != nil {
		return nil, e
	}
	return m, nil
}
func (m *Manager) Certificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.certificate, nil
}
func (m *Manager) PublicCA() []byte {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return append([]byte(nil), m.publicCA...)
}
func (m *Manager) View() View {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return View{m.settings.Host, m.settings.Mode, m.certificate.Leaf.NotAfter, "/device-ca.crt"}
}
func (m *Manager) Refresh() error { m.mu.Lock(); defer m.mu.Unlock(); return m.refreshLocked() }
func (m *Manager) SetHost(host string) error {
	if !ValidHost(host) {
		return errors.New("invalid IP address or DNS name")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.settings
	m.settings.Host = host
	if e := m.refreshLocked(); e != nil {
		m.settings = previous
		return e
	}
	if e := m.save(); e != nil {
		m.settings = previous
		_ = m.refreshLocked()
		return e
	}
	return nil
}
func (m *Manager) UseAutomatic() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	previous := m.settings
	m.settings.Mode = "auto"
	if e := m.refreshLocked(); e != nil {
		m.settings = previous
		return e
	}
	return m.save()
}
func (m *Manager) Install(certPEM, keyPEM []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	pair, e := checkedPair(certPEM, keyPEM, m.settings.Host)
	if e != nil {
		return e
	}
	dir := filepath.Join(m.dir, "tls")
	if e = write(filepath.Join(dir, "manual-cert.pem"), certPEM, 0600); e != nil {
		return e
	}
	if e = write(filepath.Join(dir, "manual-key.pem"), keyPEM, 0600); e != nil {
		return e
	}
	previous := m.settings
	m.settings.Mode = "manual"
	if e = m.save(); e != nil {
		m.settings = previous
		return e
	}
	m.certificate = pair
	return nil
}
func (m *Manager) save() error {
	raw, e := json.Marshal(m.settings)
	if e != nil {
		return e
	}
	return write(filepath.Join(m.dir, "connection.json"), raw, 0600)
}
func checkedPair(certPEM, keyPEM []byte, host string) (*tls.Certificate, error) {
	pair, e := tls.X509KeyPair(certPEM, keyPEM)
	if e != nil {
		return nil, errors.New("certificate and key do not match")
	}
	leaf, e := x509.ParseCertificate(pair.Certificate[0])
	if e != nil {
		return nil, errors.New("invalid certificate")
	}
	if e = leaf.VerifyHostname(host); e != nil {
		return nil, errors.New("certificate does not match the configured IP or domain")
	}
	if time.Now().Before(leaf.NotBefore) || time.Now().After(leaf.NotAfter) {
		return nil, errors.New("certificate is not valid now")
	}
	pair.Leaf = leaf
	return &pair, nil
}
func (m *Manager) refreshLocked() error {
	dir := filepath.Join(m.dir, "tls")
	authority := filepath.Join(dir, "authority")
	for _, p := range []string{dir, authority} {
		if e := os.MkdirAll(p, 0700); e != nil {
			return e
		}
	}
	rootPath, keyPath := filepath.Join(authority, "ca.crt"), filepath.Join(authority, "ca.key")
	rootPEM, e := os.ReadFile(rootPath)
	if os.IsNotExist(e) {
		if _, keyErr := os.Stat(keyPath); !os.IsNotExist(keyErr) {
			return errors.New("CA certificate missing; restore the complete data directory")
		}
		key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if e != nil {
			return e
		}
		template := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Worker installation CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, MaxPathLen: 0, MaxPathLenZero: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
		der, e := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
		if e != nil {
			return e
		}
		raw, e := x509.MarshalPKCS8PrivateKey(key)
		if e != nil {
			return e
		}
		if e = write(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), 0600); e != nil {
			return e
		}
		rootPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
		if e = write(rootPath, rootPEM, 0644); e != nil {
			return e
		}
	} else if e != nil {
		return e
	}
	block, _ := pem.Decode(rootPEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return errors.New("invalid installation CA")
	}
	root, e := x509.ParseCertificate(block.Bytes)
	if e != nil || !root.IsCA {
		return errors.New("invalid installation CA")
	}
	rootPEM = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: root.Raw})
	raw, e := os.ReadFile(keyPath)
	if e != nil {
		return e
	}
	keyBlock, _ := pem.Decode(raw)
	if keyBlock == nil {
		return errors.New("invalid CA key")
	}
	var key any
	if keyBlock.Type == "RSA PRIVATE KEY" {
		key, e = x509.ParsePKCS1PrivateKey(keyBlock.Bytes)
	} else {
		key, e = x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	}
	signer, ok := key.(crypto.Signer)
	if e != nil || !ok {
		return errors.New("invalid CA key")
	}
	pub1, _ := x509.MarshalPKIXPublicKey(root.PublicKey)
	pub2, _ := x509.MarshalPKIXPublicKey(signer.Public())
	if string(pub1) != string(pub2) {
		return errors.New("CA key does not match certificate")
	}
	m.publicCA = rootPEM
	if e = write(filepath.Join(m.dir, "device-ca.crt"), rootPEM, 0644); e != nil {
		return e
	}
	if m.settings.Mode == "manual" {
		cert, e := os.ReadFile(filepath.Join(dir, "manual-cert.pem"))
		if e != nil {
			return e
		}
		key, e := os.ReadFile(filepath.Join(dir, "manual-key.pem"))
		if e != nil {
			return e
		}
		pair, e := checkedPair(cert, key, m.settings.Host)
		if e == nil {
			m.certificate = pair
		}
		return e
	}
	certFile, leafKeyFile := filepath.Join(dir, "fullchain.pem"), filepath.Join(dir, "privkey.pem")
	cert, ce := os.ReadFile(certFile)
	leafKey, ke := os.ReadFile(leafKeyFile)
	if ce == nil && ke == nil {
		if pair, e := checkedPair(cert, leafKey, m.settings.Host); e == nil && time.Until(pair.Leaf.NotAfter) > 30*24*time.Hour {
			pool := x509.NewCertPool()
			pool.AddCert(root)
			if _, e = pair.Leaf.Verify(x509.VerifyOptions{Roots: pool, DNSName: m.settings.Host}); e == nil {
				m.certificate = pair
				return nil
			}
		}
	}
	if time.Until(root.NotAfter) < 31*24*time.Hour {
		return errors.New("installation CA expires soon; renew trust before issuing certificates")
	}
	leafKeyPair, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		return e
	}
	leaf := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "Worker dispatcher"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(397 * 24 * time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	if ip := net.ParseIP(m.settings.Host); ip != nil {
		leaf.IPAddresses = []net.IP{ip}
	} else {
		leaf.DNSNames = []string{m.settings.Host}
	}
	der, e := x509.CreateCertificate(rand.Reader, leaf, root, &leafKeyPair.PublicKey, signer)
	if e != nil {
		return e
	}
	private, e := x509.MarshalPKCS8PrivateKey(leafKeyPair)
	if e != nil {
		return e
	}
	cert = append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), rootPEM...)
	leafKey = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: private})
	if e = write(leafKeyFile, leafKey, 0600); e != nil {
		return e
	}
	if e = write(certFile, cert, 0644); e != nil {
		return e
	}
	m.certificate, e = checkedPair(cert, leafKey, m.settings.Host)
	return e
}
func serial() *big.Int {
	n, e := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if e != nil {
		panic("random source unavailable")
	}
	return n
}
func write(path string, raw []byte, mode os.FileMode) error {
	if info, e := os.Lstat(path); e == nil && info.Mode()&os.ModeSymlink != 0 {
		return errors.New("refusing certificate/configuration symlink")
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".worker-")
	if e != nil {
		return e
	}
	defer os.Remove(f.Name())
	if e = f.Chmod(mode); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(raw); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	return os.Rename(f.Name(), path)
}
