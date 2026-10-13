---
title: "Ollama 本地部署 Qwen-Coder-1.5b 接入 Continue 实现代码补全"
slug: "ollama-qwen-coder-continue-autocomplete"
description: "用 Ollama 在本地跑 Qwen2.5-Coder 1.5B，接入 VS Code 的 Continue 插件做代码补全，并用 ollama ps 验证调用链路是否真的走通。"
pubDate: 2026-09-28
updatedAt: 2026-10-13
tags: ["ollama", "ai", "vscode", "linux"]
draft: false
syncedFrom: "STX/AI/Ollama本地部署Qwen-Coder-1.5b接入Continue实现代码补全.md"
---

## Preword

因为自己在VSCODE开发时使用copilot实现代码补全经常把额度用超, 导致自己无法扮演好tab工程师的角色. 我决定通过api来将一些高性价比模型接入Continue扩展来实现代码补全的功能. 但是和GPT进行探讨时发现实现代码补全功能的模型其实是小模型, 完全可以部署在本地, 并且占用资源也不多. 那么当tab工程师只需要付电脑电费就可以了😊, 就无需api来付费调用了.

## Ubuntu安装Ollama并部署Qwen-Coder-1.5b

### 安装ollama

gpt老师推荐的是qwen-coder-1.5b模型, 量小占用资源少, 部署本地免费且快速. so I use it.

```bash
# 安装ollama
curl -fsSL https://ollama.com/install.sh | sh

# 检查版本
ollama --version
```

如果能看到版本号，就可以了。

然后检查服务：

```
systemctl status ollama
```

如果看到：

```
Active: active (running)
```

说明 Ollama 已经在后台运行。

### 部署Qwen-Coder-1.5b

直接：

```
ollama pull qwen2.5-coder:1.5b
```

第一次会下载模型，所以需要等一会儿。

下载完成后：

```
ollama list
```

应该能看到类似：

```
NAME                    SIZE
qwen2.5-coder:1.5b      ...
```

### 测试 Ollama

运行：

```
ollama run qwen2.5-coder:1.5b
```

如果可以正常对话接着下一步

### 改Continue插件配置文件

```yaml
name: Main Config
version: 1.0.0
schema: v1

models:
  - name: Qwen2.5 Coder 1.5B
    provider: ollama
    model: qwen2.5-coder:1.5b
    roles:
      - autocomplete
```


将这段复制到你Continue插件的main config里即可本地使用代码补全啦. 

我的电脑是16g内存, 看模型占用为将近2g, 还可以的.

### 检查模型是否被调用


通过执行以下命令可以检查当前有没有模型被调用：

```
ollama ps
```

如果刚开机可能没有模型：

```
NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL
```

然后在 VS Code 里面触发一次 AI 补全。

再执行：

```
ollama ps
```

应该能看到：

```
NAME                    ID       SIZE      PROCESSOR
qwen2.5-coder:1.5b      ...      ...       ...
```

这就证明：

> Continue → Ollama → Qwen2.5-Coder 1.5B

整个链路通了。

## Windows

如果是windows的话除了安装ollama是直接去官网下载安装包, 只和上述操作一样. 命令在powershell里输入.

另外记得设置一下模型存放位置, 不要放到C盘喽! 