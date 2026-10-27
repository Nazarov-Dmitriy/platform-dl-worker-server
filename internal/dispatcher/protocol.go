package dispatcher

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/dlclark/regexp2"
	"github.com/gowebpki/jcs"
	"github.com/santhosh-tekuri/jsonschema/v6"
	"titunki/worker-server/contracts"
)

type APIError struct {
	Status    int    `json:"-"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	Permanent bool   `json:"permanent"`
}

func (e *APIError) Error() string { return e.Code }
func problem(status int, code, message string) error {
	return &APIError{status, code, message, status < 500}
}

type JobRequest struct {
	ProtocolVersion    string          `json:"protocolVersion"`
	ID                 string          `json:"id"`
	Type               string          `json:"type"`
	Source             Source          `json:"source"`
	Params             json.RawMessage `json:"params"`
	MaxOutputBytes     int64           `json:"maxOutputBytes"`
	MaxDurationSeconds int64           `json:"maxDurationSeconds"`
	ClientReference    string          `json:"clientReference,omitempty"`
}
type Source struct {
	ObjectName  string       `json:"objectName"`
	Revision    string       `json:"revision"`
	Bytes       int64        `json:"bytes"`
	SHA256      string       `json:"sha256"`
	ContentType string       `json:"contentType"`
	Role        string       `json:"role"`
	Kind        string       `json:"kind"`
	Files       []SourcePart `json:"files,omitempty"`
}
type SourcePart struct {
	Path       string `json:"path"`
	ObjectName string `json:"objectName"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
}
type Step struct {
	Name     string    `json:"name"`
	Language string    `json:"language,omitempty"`
	Status   string    `json:"status"`
	Error    *APIError `json:"error,omitempty"`
}
type Fence struct {
	AssignmentID    string `json:"assignmentId"`
	Generation      int64  `json:"generation"`
	DispatcherEpoch string `json:"dispatcherEpoch"`
}
type ReleaseReceipt struct {
	ReleaseID        string `json:"releaseId"`
	JobID            string `json:"jobId"`
	ReleasedAt       string `json:"releasedAt"`
	DispatcherEpoch  string `json:"dispatcherEpoch"`
	Scope            string `json:"scope"`
	SafeToRunLocally bool   `json:"safeToRunLocally"`
}
type JobView struct {
	ProtocolVersion    string            `json:"protocolVersion"`
	ID                 string            `json:"id"`
	Type               string            `json:"type"`
	Status             string            `json:"status"`
	Revision           int64             `json:"revision"`
	UpdatedAt          string            `json:"updatedAt"`
	Progress           *float64          `json:"progress"`
	QueueDelayed       bool              `json:"queueDelayed"`
	ManualEntryOffered bool              `json:"manualEntryOffered"`
	Steps              []Step            `json:"steps"`
	Stage              string            `json:"stage,omitempty"`
	LastProgressAt     string            `json:"lastProgressAt,omitempty"`
	Error              *APIError         `json:"error,omitempty"`
	Artifact           *Artifact         `json:"artifact,omitempty"`
	ReleaseReceipt     *ReleaseReceipt   `json:"releaseReceipt,omitempty"`
	PublicationClaim   *PublicationClaim `json:"publicationClaim,omitempty"`
	Actionable         bool              `json:"actionable,omitempty"`
}
type ArtifactFile struct {
	Path        string `json:"path"`
	Bytes       int64  `json:"bytes"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
	Kind        string `json:"kind"`
	Language    string `json:"language,omitempty"`
}
type Rendition struct {
	Quality   string `json:"quality"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Bandwidth int    `json:"bandwidth"`
	Mode      string `json:"mode"`
	Playlist  string `json:"playlist"`
}
type Manifest struct {
	Files            []ArtifactFile `json:"files"`
	Steps            []Step         `json:"steps"`
	DetectedLanguage string         `json:"detectedLanguage,omitempty"`
	MasterPath       string         `json:"masterPath,omitempty"`
	Renditions       []Rendition    `json:"renditions,omitempty"`
}
type Artifact struct {
	ID             string   `json:"id"`
	ManifestSHA256 string   `json:"manifestSha256"`
	Fence          Fence    `json:"fence"`
	Manifest       Manifest `json:"manifest"`
}
type Link struct {
	Path       string            `json:"path"`
	ObjectName string            `json:"objectName"`
	URL        string            `json:"url"`
	ExpiresAt  string            `json:"expiresAt"`
	Method     string            `json:"method"`
	Headers    map[string]string `json:"headers"`
}
type TransferGrant struct {
	ProtocolVersion string `json:"protocolVersion"`
	RequestID       string `json:"requestId"`
	Fence           Fence  `json:"fence"`
	Links           []Link `json:"links"`
	Page            int    `json:"page"`
	LastPage        bool   `json:"lastPage"`
}
type TransferRequest struct {
	ID             string    `json:"id"`
	Kind           string    `json:"kind"`
	Fence          Fence     `json:"fence"`
	SourceRevision string    `json:"sourceRevision,omitempty"`
	Artifact       *Artifact `json:"artifact,omitempty"`
}
type PublicationClaim struct {
	ProtocolVersion string `json:"protocolVersion"`
	ClaimID         string `json:"claimId"`
	ArtifactID      string `json:"artifactId"`
	Fence           Fence  `json:"fence"`
	ClaimedAt       string `json:"claimedAt"`
}
type GrantDelivery struct {
	DeviceID string
	Kind     string
	JobID    string
	Fence    Fence
	Grant    TransferGrant
}
type PublicationDelivery struct {
	DeviceID   string
	JobID      string
	Fence      Fence
	ArtifactID string
	Outcome    string
}
type Pair struct {
	Source string `json:"source"`
	Target string `json:"target"`
}
type Capability struct {
	Code                  string   `json:"code"`
	RecognitionLanguages  []string `json:"recognitionLanguages"`
	TranslationDirections []Pair   `json:"translationDirections"`
	AutoDetect            bool     `json:"autoDetect"`
	Formats               []string `json:"formats"`
	Availability          string   `json:"availability"`
	ProfilePolicies       []string `json:"profilePolicies"`
}
type Usage struct {
	CPUPercent         float64  `json:"cpuPercent"`
	MemoryUsedPercent  float64  `json:"memoryUsedPercent"`
	MemoryPressure     string   `json:"memoryPressure"`
	DiskUsedPercent    float64  `json:"diskUsedPercent"`
	FreeMemoryBytes    int64    `json:"freeMemoryBytes"`
	FreeDiskBytes      int64    `json:"freeDiskBytes"`
	FreeVRAMBytes      *int64   `json:"freeVramBytes"`
	EncoderBusyPercent *float64 `json:"encoderBusyPercent"`
	AvailableSlots     int      `json:"availableSlots"`
	Paused             bool     `json:"paused"`
	WorkDiskAvailable  bool     `json:"workDiskAvailable"`
}
type Site struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Enabled    bool     `json:"enabled"`
	Weight     int      `json:"weight"`
	Operations []string `json:"operations"`
	Revision   int64    `json:"revision"`
}
type Device struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Enabled  bool   `json:"enabled"`
	Revision int64  `json:"revision"`
}
type Principal struct{ ID, Purpose, TokenID string }
type Offer struct {
	JobID          string     `json:"jobId"`
	Fence          Fence      `json:"fence"`
	OfferExpiresAt string     `json:"offerExpiresAt"`
	Job            JobRequest `json:"job"`
}
type Lease struct {
	JobID        string `json:"jobId"`
	Fence        Fence  `json:"fence"`
	RenewalID    string `json:"renewalId"`
	LeaseSeconds int    `json:"leaseSeconds"`
	ExpiresAt    string `json:"expiresAt"`
}
type StatusUpdate struct {
	Stage            string
	Progress         *float64
	ActivitySequence int64
	Steps            []Step
}
type TokenView struct {
	TokenID     string `json:"tokenId"`
	Purpose     string `json:"purpose"`
	PrincipalID string `json:"principalId"`
	CreatedAt   string `json:"createdAt"`
	Revoked     bool   `json:"revoked"`
}
type ModelFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	URL    string `json:"url"`
}
type ModelEntry struct {
	Files                 []ModelFile `json:"files,omitempty"`
	ID                    string      `json:"id"`
	Revision              string      `json:"revision"`
	Executor              string      `json:"executor"`
	Purpose               string      `json:"purpose"`
	OS                    []string    `json:"os"`
	Architectures         []string    `json:"architectures"`
	Accelerators          []string    `json:"accelerators"`
	RecognitionLanguages  []string    `json:"recognitionLanguages"`
	TranslationDirections []Pair      `json:"translationDirections"`
	DownloadBytes         int64       `json:"downloadBytes"`
	MinimumRAMBytes       int64       `json:"minimumRamBytes"`
	MinimumVRAMBytes      int64       `json:"minimumVramBytes"`
	SHA256                string      `json:"sha256"`
	DownloadURL           string      `json:"downloadUrl"`
	License               string      `json:"license"`
	DescriptionSource     string      `json:"descriptionSource"`
}
type CommandView struct {
	RequestID string    `json:"requestId"`
	Status    string    `json:"status"`
	Progress  *float64  `json:"progress"`
	Error     *APIError `json:"error,omitempty"`
}
type AdminCommand struct {
	RequestID     string          `json:"requestId"`
	Type          string          `json:"type"`
	ModelID       string          `json:"modelId,omitempty"`
	ModelRevision string          `json:"modelRevision,omitempty"`
	Settings      json.RawMessage `json:"settings,omitempty"`
}
type AdminActor struct {
	ID, Login, Role string
	ManageSites     bool
}
type DeviceSettings struct {
	WorkDirectory          string `json:"workDirectory,omitempty"`
	Paused                 bool   `json:"paused"`
	Autostart              bool   `json:"autostart"`
	MaxParallel            int    `json:"maxParallel"`
	CPUThresholdPercent    int    `json:"cpuThresholdPercent"`
	MemoryThresholdPercent int    `json:"memoryThresholdPercent"`
	DiskThresholdPercent   int    `json:"diskThresholdPercent"`
}

func UUID() string {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		panic(e)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func stamp(t time.Time) string                       { return t.UTC().Format(time.RFC3339Nano) }
func digest(data []byte) string                      { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func canonicalTransform(data []byte) ([]byte, error) { return jcs.Transform(data) }
func contains(values []string, value string) bool {
	for _, v := range values {
		if v == value {
			return true
		}
	}
	return false
}
func encode(v any) []byte {
	b, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return b
}

type schemaRegexp regexp2.Regexp

func (r *schemaRegexp) MatchString(s string) bool {
	ok, e := (*regexp2.Regexp)(r).MatchString(s)
	return e == nil && ok
}
func (r *schemaRegexp) String() string { return (*regexp2.Regexp)(r).String() }

type Validator struct{ schemas map[string]*jsonschema.Schema }

func NewValidator() (*Validator, error) {
	raw, e := contracts.Files.ReadFile("v2/protocol.schema.json")
	if e != nil {
		return nil, e
	}
	doc, e := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if e != nil {
		return nil, e
	}
	c := jsonschema.NewCompiler()
	c.AssertFormat()
	c.UseRegexpEngine(func(s string) (jsonschema.Regexp, error) {
		r, e := regexp2.Compile(s, regexp2.ECMAScript)
		if e != nil {
			return nil, e
		}
		r.MatchTimeout = 100 * time.Millisecond
		return (*schemaRegexp)(r), nil
	})
	if e = c.AddResource("schema.json", doc); e != nil {
		return nil, e
	}
	v := &Validator{schemas: map[string]*jsonschema.Schema{}}
	for _, name := range []string{"JobRequest", "Usage", "OperationCapability", "JobView", "DeviceMessage", "Fence", "Mutation", "Error", "Step", "Capabilities", "JobPage", "TransferGrant", "TransferPage", "PublicationClaimRequest", "PublicationDecision", "PublicationClaim", "Artifact", "MutationAck", "PublicationAck", "ModelEntry", "AdminCommand", "CommandView", "Login", "Session", "AdminSite", "AdminDevice", "AdminAccount", "AdminAccountUpdate", "AdminSiteView", "AdminDeviceView", "AdminAccountView", "TokenCreate", "IssuedToken", "TokenPage", "ModelPage"} {
		s, e := c.Compile("schema.json#/$defs/" + name)
		if e != nil {
			return nil, e
		}
		v.schemas[name] = s
	}
	return v, nil
}
func (v *Validator) Check(name string, raw []byte) error {
	canonical, e := jcs.Transform(raw)
	if e != nil {
		return problem(400, "INVALID_REQUEST", "Invalid or ambiguous JSON")
	}
	value, e := jsonschema.UnmarshalJSON(bytes.NewReader(canonical))
	if e != nil {
		return problem(400, "INVALID_REQUEST", "Invalid JSON")
	}
	if e = v.schemas[name].Validate(value); e != nil {
		return problem(400, "INVALID_REQUEST", "Request does not match protocol 2.0")
	}
	return nil
}
func (v *Validator) Request(raw []byte) (JobRequest, []byte, string, error) {
	var r JobRequest
	if e := v.Check("JobRequest", raw); e != nil {
		return r, nil, "", e
	}
	canonical, e := jcs.Transform(raw)
	if e != nil {
		return r, nil, "", e
	}
	if e = json.Unmarshal(canonical, &r); e != nil {
		return r, nil, "", e
	}
	r.ID = strings.ToLower(r.ID)
	r.Source.Revision = strings.ToLower(r.Source.Revision)
	canonical, e = jcs.Transform(encode(r))
	if e != nil {
		return r, nil, "", e
	}
	if r.Source.Kind == "HLS" {
		seen := map[string]bool{}
		var size int64
		for _, f := range r.Source.Files {
			if seen[f.Path] {
				return r, nil, "", problem(400, "INVALID_SOURCE", "Duplicate HLS paths")
			}
			seen[f.Path] = true
			size += f.Bytes
			if size > 9007199254740991 {
				return r, nil, "", problem(400, "INVALID_SOURCE", "Source size overflow")
			}
		}
		if size != r.Source.Bytes {
			return r, nil, "", problem(400, "INVALID_SOURCE", "HLS size mismatch")
		}
		parts := append([]SourcePart(nil), r.Source.Files...)
		sortParts(parts)
		b, e := jcs.Transform(encode(parts))
		if e != nil || digest(b) != r.Source.SHA256 {
			return r, nil, "", problem(400, "INVALID_SOURCE", "HLS source checksum mismatch")
		}
	}
	var params struct {
		IncludeOriginal bool     `json:"includeOriginal"`
		TargetLanguages []string `json:"targetLanguages"`
		Subtitles       *struct {
			IncludeOriginal bool     `json:"includeOriginal"`
			TargetLanguages []string `json:"targetLanguages"`
		} `json:"subtitles"`
	}
	_ = json.Unmarshal(r.Params, &params)
	if r.Type == "media.subtitles" && !params.IncludeOriginal && len(params.TargetLanguages) == 0 || params.Subtitles != nil && !params.Subtitles.IncludeOriginal && len(params.Subtitles.TargetLanguages) == 0 {
		return r, nil, "", problem(400, "INVALID_REQUEST", "Select at least one subtitle language")
	}
	return r, canonical, digest(canonical), nil
}
