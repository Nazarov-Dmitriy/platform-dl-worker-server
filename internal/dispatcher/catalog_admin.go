package dispatcher

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// Models come from huggingface.co and nowhere else. A single host keeps the
// catalog from becoming a way to push an arbitrary binary to every device.
const modelHost = "huggingface.co"

var (
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$`)
	revisionPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
	catalogFilePath   = regexp.MustCompile(`^[A-Za-z0-9_-]+(?:[./][A-Za-z0-9_-]+)*$`)
	catalogLanguage   = regexp.MustCompile(`^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$`)
	lfsObjectID       = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// The files transformers.js loads for a quantized seq2seq translator.
var translationFiles = []string{
	"config.json", "generation_config.json", "tokenizer.json",
	"tokenizer_config.json", "onnx/encoder_model_quantized.onnx",
	"onnx/decoder_model_merged_quantized.onnx",
}

type CatalogRequest struct {
	ID         string   `json:"id"`
	Repository string   `json:"repository"`
	Revision   string   `json:"revision"`
	Purpose    string   `json:"purpose"`
	File       string   `json:"file"`
	Operations []string `json:"operations"`
	Note       string   `json:"note"`
	Source     string   `json:"source"`
	Target     string   `json:"target"`
}

type huggingFaceFile struct {
	Type string `json:"type"`
	Path string `json:"path"`
	Size int64  `json:"size"`
	LFS  *struct {
		OID  string `json:"oid"`
		Size int64  `json:"size"`
	} `json:"lfs"`
}

// Reads sizes and digests from the repository listing. The weights themselves
// are never fetched: the dispatcher stores descriptions and the devices
// download, so adding a model costs one small request.
func (s *Store) huggingFaceTree(ctx context.Context, repository, revision string) (map[string]huggingFaceFile, error) {
	url := "https://" + modelHost + "/api/models/" + repository + "/tree/" + revision + "?recursive=true"
	req, e := http.NewRequestWithContext(ctx, "GET", url, nil)
	if e != nil {
		return nil, e
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, e := client.Do(req)
	if e != nil {
		return nil, problem(502, "CATALOG_SOURCE_UNAVAILABLE", "Не удалось получить данные с huggingface.co")
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return nil, problem(404, "CATALOG_SOURCE_NOT_FOUND", "Репозиторий или ревизия не найдены на huggingface.co")
	}
	if response.StatusCode != 200 {
		return nil, problem(502, "CATALOG_SOURCE_UNAVAILABLE", "huggingface.co ответил ошибкой")
	}
	raw, e := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if e != nil {
		return nil, problem(502, "CATALOG_SOURCE_UNAVAILABLE", "Ответ huggingface.co не прочитан")
	}
	var items []huggingFaceFile
	if json.Unmarshal(raw, &items) != nil {
		return nil, problem(502, "CATALOG_SOURCE_UNAVAILABLE", "Ответ huggingface.co не распознан")
	}
	out := map[string]huggingFaceFile{}
	for _, item := range items {
		if item.Type == "file" {
			out[item.Path] = item
		}
	}
	return out, nil
}

// A digest is trustworthy only for an LFS-backed file, where the object id is
// the file's SHA-256. A small plain file is served from git and has none, so
// the entry is refused rather than stored with an unverifiable hash.
func describeCatalogFile(tree map[string]huggingFaceFile, repository, revision, path string) (ModelFile, error) {
	item, ok := tree[path]
	if !ok {
		return ModelFile{}, problem(400, "CATALOG_FILE_MISSING", "В репозитории нет файла "+path)
	}
	if item.LFS == nil || !lfsObjectID.MatchString(item.LFS.OID) {
		return ModelFile{}, problem(400, "CATALOG_FILE_UNVERIFIABLE", "huggingface.co не отдаёт SHA-256 для файла "+path)
	}
	return ModelFile{
		Path:   path,
		Bytes:  item.LFS.Size,
		SHA256: item.LFS.OID,
		URL:    "https://" + modelHost + "/" + repository + "/resolve/" + revision + "/" + path,
	}, nil
}

// Catalog figures are read by people, so the requirement is rounded up to a
// whole gigabyte rather than reported to the byte.
func roundRAM(bytes int64) int64 {
	const gb = int64(1) << 30
	if bytes <= gb {
		return gb
	}
	return ((bytes + gb - 1) / gb) * gb
}

func (s *Store) buildCatalogEntry(ctx context.Context, req CatalogRequest) (ModelEntry, error) {
	if !repositoryPattern.MatchString(req.Repository) {
		return ModelEntry{}, problem(400, "INVALID_CATALOG", "Укажите репозиторий в виде владелец/название")
	}
	if !revisionPattern.MatchString(req.Revision) {
		return ModelEntry{}, problem(400, "INVALID_CATALOG", "Укажите ревизию репозитория")
	}
	if !revisionPattern.MatchString(req.ID) {
		return ModelEntry{}, problem(400, "INVALID_CATALOG", "Укажите короткое имя модели")
	}
	for _, op := range req.Operations {
		if !contains([]string{"media.transcode", "media.transcribe", "media.subtitles"}, op) {
			return ModelEntry{}, problem(400, "INVALID_CATALOG", "Неизвестное назначение задания")
		}
	}
	if len(req.Note) > 1000 {
		return ModelEntry{}, problem(400, "INVALID_CATALOG", "Пояснение слишком длинное")
	}
	tree, e := s.huggingFaceTree(ctx, req.Repository, req.Revision)
	if e != nil {
		return ModelEntry{}, e
	}
	entry := ModelEntry{
		ID: req.ID, Revision: req.Revision, Purpose: req.Purpose,
		OS: []string{"windows", "darwin", "linux"}, Architectures: []string{"amd64", "arm64"},
		RecognitionLanguages: []string{}, TranslationDirections: []Pair{},
		MinimumVRAMBytes:  0,
		License:           "see-repository",
		DescriptionSource: "https://" + modelHost + "/" + req.Repository,
		Operations:        req.Operations,
	}
	switch req.Purpose {
	case "RECOGNITION":
		if !catalogFilePath.MatchString(req.File) {
			return ModelEntry{}, problem(400, "INVALID_CATALOG", "Укажите файл весов в репозитории")
		}
		file, e := describeCatalogFile(tree, req.Repository, req.Revision, req.File)
		if e != nil {
			return ModelEntry{}, e
		}
		entry.Executor = "whisper.cpp"
		entry.Accelerators = []string{"cpu", "cuda", "metal"}
		entry.RecognitionLanguages = baseWhisperLanguages()
		entry.DownloadBytes = file.Bytes
		entry.SHA256 = file.SHA256
		entry.DownloadURL = file.URL
		// Whisper holds the weights in memory while it runs, plus working
		// buffers of the same order.
		entry.MinimumRAMBytes = roundRAM(file.Bytes * 2)
	case "TRANSLATION":
		if !catalogLanguage.MatchString(req.Source) || !catalogLanguage.MatchString(req.Target) || req.Source == req.Target {
			return ModelEntry{}, problem(400, "INVALID_CATALOG", "Укажите разные языки источника и перевода")
		}
		files := []ModelFile{}
		var total int64
		for _, path := range translationFiles {
			file, e := describeCatalogFile(tree, req.Repository, req.Revision, path)
			if e != nil {
				return ModelEntry{}, e
			}
			files = append(files, file)
			total += file.Bytes
		}
		canonical, e := canonicalTransform(encode(files))
		if e != nil {
			return ModelEntry{}, e
		}
		entry.Executor = "transformers-js"
		entry.Accelerators = []string{"cpu"}
		entry.Files = files
		entry.TranslationDirections = []Pair{{Source: req.Source, Target: req.Target}}
		entry.DownloadBytes = total
		// A multi-file package is identified by the digest of its manifest;
		// every file still carries its own hash.
		entry.SHA256 = digest(canonical)
		entry.DownloadURL = "https://" + modelHost + "/" + req.Repository
		entry.MinimumRAMBytes = roundRAM(total * 2)
	default:
		return ModelEntry{}, problem(400, "INVALID_CATALOG", "Назначение модели должно быть RECOGNITION или TRANSLATION")
	}
	return entry, nil
}

// Columns hold the catalog metadata, so the stored entry stays a plain
// ModelEntry: what a device reads is exactly what the contract describes.
func stripCatalogMeta(entry ModelEntry) ModelEntry {
	entry.Pinned = false
	entry.Note = ""
	return entry
}

func (s *Store) AdminAddModel(ctx context.Context, a AdminActor, raw []byte) (map[string]any, error) {
	if e := requireOwner(a); e != nil {
		return nil, e
	}
	var req CatalogRequest
	if json.Unmarshal(raw, &req) != nil {
		return nil, problem(400, "INVALID_CATALOG", "Некорректный запрос")
	}
	req.Repository = strings.TrimSpace(req.Repository)
	req.Revision = strings.TrimSpace(req.Revision)
	req.ID = strings.TrimSpace(req.ID)
	req.File = strings.TrimSpace(req.File)
	req.Source = strings.TrimSpace(req.Source)
	req.Target = strings.TrimSpace(req.Target)
	entry, e := s.buildCatalogEntry(ctx, req)
	if e != nil {
		return nil, e
	}
	stored := stripCatalogMeta(entry)
	if e = s.validator.Check("ModelEntry", encode(stored)); e != nil {
		return nil, e
	}
	e = s.transaction(ctx, func(tx *sql.Tx) error {
		var pinned int
		switch scanErr := tx.QueryRow("SELECT pinned FROM model_catalog WHERE id=? AND revision=?", entry.ID, entry.Revision).Scan(&pinned); {
		case scanErr == nil && pinned == 1:
			return problem(409, "MODEL_PINNED", "Закреплённую запись нельзя заменить")
		case scanErr != nil && !errors.Is(scanErr, sql.ErrNoRows):
			return scanErr
		}
		if _, e := tx.Exec("INSERT OR REPLACE INTO model_catalog(id,revision,entry,pinned,note) VALUES(?,?,?,0,?)",
			entry.ID, entry.Revision, encode(stored), req.Note); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "CATALOG_IMPORTED", "", entry.ID)
	})
	if e != nil {
		return nil, e
	}
	entry.Note = req.Note
	entry.Operations = modelOperations(entry)
	return map[string]any{"model": entry}, nil
}

func (s *Store) AdminDeleteModel(ctx context.Context, a AdminActor, id, revision string) error {
	if e := requireOwner(a); e != nil {
		return e
	}
	return s.transaction(ctx, func(tx *sql.Tx) error {
		var pinned int
		e := tx.QueryRow("SELECT pinned FROM model_catalog WHERE id=? AND revision=?", id, revision).Scan(&pinned)
		if errors.Is(e, sql.ErrNoRows) {
			return problem(404, "NOT_FOUND", "Модель не найдена в каталоге")
		}
		if e != nil {
			return e
		}
		if pinned == 1 {
			return problem(409, "MODEL_PINNED", "Закреплённую запись нельзя удалить")
		}
		var installed int
		if e = tx.QueryRow("SELECT count(*) FROM device_models WHERE model_id=? AND revision=?", id, revision).Scan(&installed); e != nil {
			return e
		}
		if installed > 0 {
			return problem(409, "MODEL_IN_USE", "Модель установлена на устройствах; сначала удалите её оттуда")
		}
		if _, e = tx.Exec("DELETE FROM model_catalog WHERE id=? AND revision=?", id, revision); e != nil {
			return e
		}
		return audit(tx, s.now().UnixMilli(), "CATALOG_IMPORTED", "", id)
	})
}
