package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const (
	Version        = "0.1.0"
	MaxFileSize    = 10 * 1024 * 1024 // 10MB
	HeartbeatEvery = 30 * time.Second
	ReconnectDelay = 5 * time.Second
	MaxSearchResults = 100
)

// 黑名单：永远不能访问的文件/目录
var blacklist = []string{
	".ssh", ".gnupg", ".aws", ".kube",
	".env", ".git/config",
	"id_rsa", "id_ed25519", "id_ecdsa",
	".npmrc", ".pypirc", ".netrc",
	"credentials", "keystore", "keychain",
}

// 命令黑名单：默认禁止的危险命令
var defaultDenyCommands = []string{
	"rm -rf /", "rm -rf /*", "mkfs", "dd if=", "> /dev/sd",
	":(){ :|:& };:", "shutdown", "reboot", "halt", "poweroff",
	"passwd", "useradd", "userdel", "visudo",
	"nc -l", "ncat -l", // 反弹 shell
}

type Config struct {
	ServerURL     string
	Key           string
	BaseDir       string
	ReadOnly      bool
	Verbose       bool
	EnableExec    bool
	AllowCommands []string // 白名单（空=允许所有非黑名单）
	DenyCommands  []string // 黑名单
	ExecTimeout   time.Duration
}

type Request struct {
	ID     string          `json:"id"`
	Action string          `json:"action"`
	Params json.RawMessage `json:"params"`
}

type Response struct {
	ID      string      `json:"id"`
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   string      `json:"error,omitempty"`
}

type FileInfo struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Size    int64  `json:"size"`
	IsDir   bool   `json:"is_dir"`
	ModTime string `json:"mod_time"`
}

type Agent struct {
	config *Config
	conn   *websocket.Conn
	done   chan struct{}
}

func NewAgent(config *Config) *Agent {
	return &Agent{config: config, done: make(chan struct{})}
}

// ─── 安全检查 ───

func (a *Agent) safePath(reqPath string) (string, error) {
	// 解析路径
	cleaned := filepath.Clean(reqPath)
	if filepath.IsAbs(cleaned) {
		// 绝对路径：必须在 baseDir 下
		if !strings.HasPrefix(cleaned, a.config.BaseDir) {
			return "", fmt.Errorf("路径越界")
		}
		return cleaned, nil
	}
	// 相对路径：拼接 baseDir
	full := filepath.Clean(filepath.Join(a.config.BaseDir, cleaned))
	if !strings.HasPrefix(full, a.config.BaseDir) {
		return "", fmt.Errorf("路径越界")
	}
	return full, nil
}

func (a *Agent) isBlacklisted(path string) bool {
	lower := strings.ToLower(path)
	for _, b := range blacklist {
		if strings.Contains(lower, b) {
			return true
		}
	}
	return false
}

func (a *Agent) relPath(absPath string) string {
	rel, err := filepath.Rel(a.config.BaseDir, absPath)
	if err != nil {
		return absPath
	}
	return rel
}

// ─── 文件操作 ───

func (a *Agent) listDir(params json.RawMessage) interface{} {
	var p struct {
		Path string `json:"path"`
	}
	json.Unmarshal(params, &p)
	if p.Path == "" {
		p.Path = "."
	}

	dir, err := a.safePath(p.Path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	if a.isBlacklisted(dir) {
		return map[string]string{"error": "访问被拒绝"}
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}

	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		if a.isBlacklisted(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:    e.Name(),
			Path:    a.relPath(filepath.Join(dir, e.Name())),
			Size:    info.Size(),
			IsDir:   e.IsDir(),
			ModTime: info.ModTime().Format("2006-01-02 15:04:05"),
		})
	}
	return map[string]interface{}{"files": files, "count": len(files), "dir": a.relPath(dir)}
}

func (a *Agent) readFile(params json.RawMessage) interface{} {
	var p struct {
		Path   string `json:"path"`
		Offset int64  `json:"offset"`
		Limit  int64  `json:"limit"`
	}
	json.Unmarshal(params, &p)

	path, err := a.safePath(p.Path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	if a.isBlacklisted(path) {
		return map[string]string{"error": "访问被拒绝"}
	}

	info, err := os.Stat(path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	if info.IsDir() {
		return map[string]string{"error": "这是一个目录"}
	}
	if info.Size() > MaxFileSize {
		return map[string]string{"error": fmt.Sprintf("文件太大: %dMB，上限 %dMB", info.Size()/1024/1024, MaxFileSize/1024/1024)}
	}

	f, err := os.Open(path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	defer f.Close()

	if p.Offset > 0 {
		f.Seek(p.Offset, io.SeekStart)
	}

	limit := info.Size()
	if p.Limit > 0 && p.Limit < limit {
		limit = p.Limit
	}

	data := make([]byte, limit)
	n, err := f.Read(data)
	if err != nil && err != io.EOF {
		return map[string]string{"error": err.Error()}
	}

	return map[string]interface{}{
		"content":  string(data[:n]),
		"size":     info.Size(),
		"path":     a.relPath(path),
		"mod_time": info.ModTime().Format("2006-01-02 15:04:05"),
	}
}

func (a *Agent) writeFile(params json.RawMessage) interface{} {
	if a.config.ReadOnly {
		return map[string]string{"error": "只读模式，无法写入"}
	}

	var p struct {
		Path    string `json:"path"`
		Content string `json:"content"`
		Append  bool   `json:"append"`
	}
	json.Unmarshal(params, &p)

	path, err := a.safePath(p.Path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	if a.isBlacklisted(path) {
		return map[string]string{"error": "访问被拒绝"}
	}

	// 确保目录存在
	os.MkdirAll(filepath.Dir(path), 0755)

	flag := os.O_WRONLY | os.O_CREATE
	if p.Append {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}

	f, err := os.OpenFile(path, flag, 0644)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	defer f.Close()

	n, err := f.WriteString(p.Content)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}

	return map[string]interface{}{"written": n, "path": a.relPath(path)}
}

func (a *Agent) searchFiles(params json.RawMessage) interface{} {
	var p struct {
		Query     string `json:"query"`
		MaxDepth  int    `json:"max_depth"`
		FileOnly  bool   `json:"file_only"`
	}
	json.Unmarshal(params, &p)

	if p.Query == "" {
		return map[string]string{"error": "搜索关键词不能为空"}
	}
	if p.MaxDepth == 0 {
		p.MaxDepth = 5
	}

	query := strings.ToLower(p.Query)
	results := make([]FileInfo, 0)
	baseDepth := strings.Count(a.config.BaseDir, string(os.PathSeparator))

	filepath.Walk(a.config.BaseDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if a.isBlacklisted(path) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		depth := strings.Count(path, string(os.PathSeparator)) - baseDepth
		if depth > p.MaxDepth {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if p.FileOnly && info.IsDir() {
			return nil
		}

		if strings.Contains(strings.ToLower(info.Name()), query) {
			results = append(results, FileInfo{
				Name:    info.Name(),
				Path:    a.relPath(path),
				Size:    info.Size(),
				IsDir:   info.IsDir(),
				ModTime: info.ModTime().Format("2006-01-02 15:04:05"),
			})
			if len(results) >= MaxSearchResults {
				return fmt.Errorf("max results")
			}
		}
		return nil
	})

	return map[string]interface{}{"results": results, "count": len(results), "query": p.Query}
}

func (a *Agent) fileInfo(params json.RawMessage) interface{} {
	var p struct {
		Path string `json:"path"`
	}
	json.Unmarshal(params, &p)

	path, err := a.safePath(p.Path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}
	if a.isBlacklisted(path) {
		return map[string]string{"error": "访问被拒绝"}
	}

	info, err := os.Stat(path)
	if err != nil {
		return map[string]string{"error": err.Error()}
	}

	return FileInfo{
		Name:    info.Name(),
		Path:    a.relPath(path),
		Size:    info.Size(),
		IsDir:   info.IsDir(),
		ModTime: info.ModTime().Format("2006-01-02 15:04:05"),
	}
}

// ─── 命令执行 ───

func (a *Agent) isCommandAllowed(command string) (bool, string) {
	if !a.config.EnableExec {
		return false, "命令执行未启用（需要 --enable-exec）"
	}

	lower := strings.ToLower(strings.TrimSpace(command))

	// 黑名单检查
	for _, deny := range a.config.DenyCommands {
		if strings.Contains(lower, strings.ToLower(deny)) {
			return false, "命令被禁止: 匹配黑名单规则 '" + deny + "'"
		}
	}
	for _, deny := range defaultDenyCommands {
		if strings.Contains(lower, strings.ToLower(deny)) {
			return false, "命令被禁止: 危险操作"
		}
	}

	// 白名单检查（如果设了白名单，命令必须以白名单中的某个开头）
	if len(a.config.AllowCommands) > 0 {
		allowed := false
		// 提取命令名（第一个词）
		cmdName := strings.Fields(lower)[0]
		// 去掉路径，只看命令名
		cmdName = filepath.Base(cmdName)
		for _, allow := range a.config.AllowCommands {
			if cmdName == strings.ToLower(allow) {
				allowed = true
				break
			}
		}
		if !allowed {
			return false, "命令不在白名单中（允许: " + strings.Join(a.config.AllowCommands, ", ") + "）"
		}
	}

	return true, ""
}

func (a *Agent) execCommand(params json.RawMessage) interface{} {
	var p struct {
		Command string `json:"command"`
		Timeout int    `json:"timeout"` // 秒，默认30
	}
	json.Unmarshal(params, &p)

	if p.Command == "" {
		return map[string]string{"error": "命令不能为空"}
	}

	allowed, reason := a.isCommandAllowed(p.Command)
	if !allowed {
		return map[string]string{"error": reason}
	}

	timeout := a.config.ExecTimeout
	if p.Timeout > 0 && time.Duration(p.Timeout)*time.Second < timeout {
		timeout = time.Duration(p.Timeout) * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", p.Command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", p.Command)
	}
	cmd.Dir = a.config.BaseDir

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	startTime := time.Now()
	err := cmd.Run()
	elapsed := time.Since(startTime)

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			return map[string]interface{}{
				"error":     "命令执行超时",
				"timeout":   timeout.Seconds(),
				"stdout":    truncate(stdout.String(), 50000),
				"stderr":    truncate(stderr.String(), 10000),
				"exit_code": -1,
			}
		} else {
			return map[string]string{"error": "执行失败: " + err.Error()}
		}
	}

	return map[string]interface{}{
		"stdout":    truncate(stdout.String(), 50000),
		"stderr":    truncate(stderr.String(), 10000),
		"exit_code": exitCode,
		"elapsed":   fmt.Sprintf("%.1fs", elapsed.Seconds()),
		"command":   p.Command,
	}
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n... (truncated)"
}

// ─── 请求分发 ───

func (a *Agent) handleRequest(req Request) Response {
	var data interface{}

	switch req.Action {
	case "ping":
		data = map[string]string{"status": "ok", "version": Version}
	case "list_dir":
		data = a.listDir(req.Params)
	case "read_file":
		data = a.readFile(req.Params)
	case "write_file":
		data = a.writeFile(req.Params)
	case "search":
		data = a.searchFiles(req.Params)
	case "file_info":
		data = a.fileInfo(req.Params)
	case "status":
		data = map[string]interface{}{
			"version":    Version,
			"base_dir":   a.config.BaseDir,
			"read_only":  a.config.ReadOnly,
			"exec_enabled": a.config.EnableExec,
			"platform":   runtime.GOOS + "/" + runtime.GOARCH,
		}
	case "exec":
		data = a.execCommand(req.Params)
	default:
		return Response{ID: req.ID, Success: false, Error: "未知操作: " + req.Action}
	}

	// 检查返回结果中是否有 error
	if m, ok := data.(map[string]string); ok {
		if errMsg, exists := m["error"]; exists {
			return Response{ID: req.ID, Success: false, Error: errMsg}
		}
	}

	return Response{ID: req.ID, Success: true, Data: data}
}

// ─── WebSocket 连接 ───

func (a *Agent) connect() error {
	u, err := url.Parse(a.config.ServerURL)
	if err != nil {
		return fmt.Errorf("URL 解析失败: %w", err)
	}

	header := make(map[string][]string)
	header["X-Agent-Key"] = []string{a.config.Key}
	header["X-Agent-Version"] = []string{Version}

	if a.config.Verbose {
		log.Printf("连接 %s ...", u.String())
	}

	conn, _, err := websocket.DefaultDialer.Dial(u.String(), header)
	if err != nil {
		return fmt.Errorf("连接失败: %w", err)
	}

	a.conn = conn
	log.Printf("✅ 已连接到 CookClaw 服务器")

	// 发送注册信息
	reg := map[string]interface{}{
		"type":         "register",
		"version":      Version,
		"base_dir":     a.config.BaseDir,
		"read_only":    a.config.ReadOnly,
		"exec_enabled": a.config.EnableExec,
		"platform":     runtime.GOOS + "/" + runtime.GOARCH,
	}
	regData, _ := json.Marshal(reg)
	conn.WriteMessage(websocket.TextMessage, regData)

	return nil
}

func (a *Agent) readLoop() {
	defer close(a.done)
	for {
		_, message, err := a.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("连接断开: %v", err)
			}
			return
		}

		if a.config.Verbose {
			log.Printf("← %s", string(message))
		}

		var req Request
		if err := json.Unmarshal(message, &req); err != nil {
			log.Printf("解析请求失败: %v", err)
			continue
		}

		// 异步处理
		go func(r Request) {
			resp := a.handleRequest(r)
			data, _ := json.Marshal(resp)
			if a.config.Verbose {
				log.Printf("→ %s", string(data))
			}
			if a.conn != nil {
				a.conn.WriteMessage(websocket.TextMessage, data)
			}
		}(req)
	}
}

func (a *Agent) heartbeat() {
	ticker := time.NewTicker(HeartbeatEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			if a.conn != nil {
				msg, _ := json.Marshal(map[string]string{"type": "heartbeat"})
				if err := a.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
					return
				}
			}
		case <-a.done:
			return
		}
	}
}

func (a *Agent) Run() {
	// 信号处理
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)

	for {
		err := a.connect()
		if err != nil {
			log.Printf("❌ %v，%v 后重试...", err, ReconnectDelay)
			time.Sleep(ReconnectDelay)
			continue
		}

		a.done = make(chan struct{})
		go a.readLoop()
		go a.heartbeat()

		select {
		case <-a.done:
			log.Printf("连接断开，重连中...")
			time.Sleep(ReconnectDelay)
		case <-interrupt:
			log.Printf("收到退出信号，断开连接...")
			a.conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			select {
			case <-a.done:
			case <-time.After(time.Second):
			}
			return
		}
	}
}

func main() {
	serverURL := flag.String("server", "wss://cookclaw.com/ws/agent", "CookClaw 服务器地址")
	key := flag.String("key", "", "Agent 连接密钥（在 CookClaw 后台获取）")
	dir := flag.String("dir", ".", "允许 Bot 访问的目录")
	readOnly := flag.Bool("readonly", false, "只读模式（Bot 只能查看不能修改）")
	enableExec := flag.Bool("enable-exec", false, "启用命令执行（谨慎使用）")
	allowCmds := flag.String("allow-commands", "", "命令白名单，逗号分隔（如: ls,cat,python3,node）")
	denyCmds := flag.String("deny-commands", "", "额外命令黑名单，逗号分隔")
	execTimeout := flag.Int("exec-timeout", 60, "命令执行超时秒数")
	verbose := flag.Bool("v", false, "显示详细日志")
	showVersion := flag.Bool("version", false, "显示版本号")

	flag.Parse()

	if *showVersion {
		fmt.Printf("cookclaw-agent v%s\n", Version)
		return
	}

	if *key == "" {
		fmt.Println("❌ 请指定连接密钥: --key=xxx")
		fmt.Println("   在 CookClaw 后台创建 Bot 后获取 Agent Key")
		fmt.Println()
		fmt.Println("用法:")
		fmt.Println("  cookclaw-agent --key=YOUR_KEY --dir=~/Documents")
		fmt.Println()
		fmt.Println("选项:")
		flag.PrintDefaults()
		os.Exit(1)
	}

	// 解析目录
	absDir, err := filepath.Abs(*dir)
	if err != nil {
		log.Fatalf("❌ 目录解析失败: %v", err)
	}
	info, err := os.Stat(absDir)
	if err != nil || !info.IsDir() {
		log.Fatalf("❌ 目录不存在: %s", absDir)
	}

	// 解析命令白名单/黑名单
	var allowList, denyList []string
	if *allowCmds != "" {
		for _, c := range strings.Split(*allowCmds, ",") {
			if t := strings.TrimSpace(c); t != "" {
				allowList = append(allowList, t)
			}
		}
	}
	if *denyCmds != "" {
		for _, c := range strings.Split(*denyCmds, ",") {
			if t := strings.TrimSpace(c); t != "" {
				denyList = append(denyList, t)
			}
		}
	}

	config := &Config{
		ServerURL:     *serverURL,
		Key:           *key,
		BaseDir:       absDir,
		ReadOnly:      *readOnly,
		Verbose:       *verbose,
		EnableExec:    *enableExec,
		AllowCommands: allowList,
		DenyCommands:  denyList,
		ExecTimeout:   time.Duration(*execTimeout) * time.Second,
	}

	fmt.Printf("🦞 CookClaw Agent v%s\n", Version)
	fmt.Printf("📁 目录: %s\n", absDir)
	if config.ReadOnly {
		fmt.Printf("🔒 模式: 只读\n")
	} else {
		fmt.Printf("✏️  模式: 读写\n")
	}
	if config.EnableExec {
		fmt.Printf("⚡ 命令执行: 已启用")
		if len(allowList) > 0 {
			fmt.Printf("（白名单: %s）", strings.Join(allowList, ", "))
		}
		fmt.Println()
	}
	fmt.Printf("🔗 服务器: %s\n", config.ServerURL)
	fmt.Println()

	agent := NewAgent(config)
	agent.Run()
}
