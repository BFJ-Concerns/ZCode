# PDF Skill — Environment Setup Guide

This document contains full platform-specific instructions for setting up the PDF skill environment.
The model should read this file when first-time setup is needed.

---

## Step 1: Platform Detection

Detect the OS and set core variables:

### macOS / Linux (bash/zsh)

```bash
OS="$(uname -s)"   # Darwin = macOS, Linux = Linux
ARCH="$(uname -m)" # x86_64 or arm64

PDF_SKILL_DIR="<skill_directory>"
export PDF_SKILL_DIR
```

### Windows (PowerShell, Win10/Win11)

```powershell
$WinVer = [System.Environment]::OSVersion.Version
$Arch   = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture

$env:PDF_SKILL_DIR = "<skill_directory>"
```

---

## Step 2: Dependency Check & Install

Run the platform-appropriate setup script:

| Platform | Command |
|----------|---------|
| macOS / Linux | `bash "$PDF_SKILL_DIR/env_setup/setup_mac_linux.sh"` |
| Windows | `powershell -ExecutionPolicy Bypass -File "$env:PDF_SKILL_DIR\env_setup\setup_windows.ps1"` |

### Required Dependencies

| Category | Package | Purpose |
|----------|---------|---------|
| **Core** Runtime | Python 3 + pip | PDF generation and processing |
| **Core** Python pkg | reportlab | Report/cover pipeline PDF generation |
| **Core** Python pkg | pypdf | PDF reading/writing/merge |
| **Core** Python pkg | PyMuPDF (fitz) | Fast PDF rendering and extraction |
| **Core** Python pkg | pikepdf | PDF manipulation (merge/split/encrypt) |
| **Core** Python pkg | pdfplumber | Text/table extraction |
| **Core** Font | CJK fonts (TrueType: SimHei/Noto/WenQuanYi/Songti…) | Chinese text + covers |
| Optional | Node.js + npm | Only for the Creative/HTML pipeline |
| Optional | playwright (npm) | HTML-to-PDF for Creative pipeline |
| Optional | Chromium (via Playwright) | Headless rendering (large download) |
| Optional | tectonic | LaTeX/Academic PDF compilation |
| On demand (not substitutable) | LibreOffice | Office-to-PDF conversion — install it; do not swap in local Office/WPS |

> **Covers no longer need Playwright.** All Report/Academic covers render with ReportLab
> (`scripts/cover_render.py`). Playwright/Chromium is required **only** for the Creative/poster
> pipeline and some HTML→PDF conversions; Tectonic **only** for the Academic/LaTeX route.
> Install these optional engines **on demand, after asking the user** (they involve large
> downloads / long first-run waits) — do not install them up front.
>
> **Once an Office→PDF task is requested, LibreOffice MUST be installed — not substituted.** Using
> the user's already-installed Word/WPS/Keynote/Pages *instead of* installing it is **forbidden**, and
> the package being large (several hundred MB) is **not** a reason to skip the install. Required:
> explain the necessity to the user (only engine that preserves themes, layouts, master slides and
> pagination faithfully), tell them the download is large, then install it — **preferring the
> Tsinghua TUNA mirror** documented in *"LibreOffice — Recommended Download Source"* at the end of
> this file (`https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/`), falling
> back to the platform package manager command below. Another program is permitted **only after** an install attempt has actually failed, and that
> failure must be reported to the user. **No install attempt = no substitute program.**

### Manual Install by Platform

#### macOS

```bash
# ── Core (always) ──
brew install python3
python3 -m pip install reportlab pypdf PyMuPDF pikepdf pdfplumber

# ── Optional: Creative/HTML pipeline (install on demand, with user's OK — large Chromium download) ──
brew install node
npm install -g playwright@1.50.0 && npx playwright install chromium
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version

# ── Optional: Academic/LaTeX (install on demand — downloads packages on first run) ──
brew install tectonic
# ── On demand, not substitutable: Office-to-PDF ──
# Preferred: Tsinghua mirror — see "LibreOffice — Recommended Download Source" below
brew install --cask libreoffice   # fallback if the mirror is unreachable
```

#### Linux (Debian/Ubuntu)

```bash
# ── Core (always) ──
sudo apt install python3 python3-pip
python3 -m pip install reportlab pypdf PyMuPDF pikepdf pdfplumber

# ── Optional: Creative/HTML pipeline (install on demand, with user's OK) ──
sudo apt install nodejs npm
npm install -g playwright@1.50.0 && npx playwright install chromium && npx playwright install-deps

# ── Optional: Academic/LaTeX (install on demand) ──
conda install -c conda-forge tectonic   # use Tsinghua mirror: conda config --add channels https://mirrors.tuna.tsinghua.edu.cn/anaconda/cloud/conda-forge/
# ── On demand, not substitutable: Office-to-PDF ──
# Preferred: Tsinghua mirror — see "LibreOffice — Recommended Download Source" below
sudo apt install libreoffice-core   # fallback if the mirror is unreachable
```

#### Windows (PowerShell)

```powershell
winget install Python.Python.3.11
winget install OpenJS.NodeJS.LTS
python -m pip install pikepdf pdfplumber pypdf reportlab PyMuPDF
npm install -g playwright@1.50.0
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
npx playwright install chromium
# optional:
scoop install tectonic                           # LaTeX
# on demand, not substitutable: prefer the Tsinghua mirror (see section below)
winget install TheDocumentFoundation.LibreOffice  # Office-to-PDF fallback
```

Alternative Windows package managers:
- `choco install python3 nodejs-lts`
- `scoop install python nodejs-lts`

---

## Step 3: Font Installation

The skill works with the fonts already installed on the machine. The setup script downloads fonts
only when the user has named a font mirror in the `ZCODE_FONT_SOURCE_URL` environment variable, and
it downloads them from nowhere else.

- **Font list**: `env_setup/font_list.txt` — one font file per line, written as the path that file
  has on a Debian-style system (`/usr/share/fonts/truetype/<group>/<file>`)
- **Font mirror**: `ZCODE_FONT_SOURCE_URL` — the base URL of a server the user chose that holds the
  files in `font_list.txt`. Use it only as the user set it or gave it to you. Never guess a value,
  and never put another font host in its place.
- **Marker file**: `.office-skill-fonts-installed` in the user font directory records a complete
  download, so later runs skip the step. Delete it to download again.

### What the Setup Script Does

| `ZCODE_FONT_SOURCE_URL` | Font step |
|-------------------------|-----------|
| Not set | Downloads nothing, prints `No font mirror named: using installed fonts`, and carries on. This is not a setup failure: see *Missing Fonts* below. |
| Set | For each line of `font_list.txt` whose file is not already in the user font directory, requests `$ZCODE_FONT_SOURCE_URL/<line>` — the line exactly as written, with `[`, `]` and spaces URL-encoded — and saves the file flat (filename only) to the user font directory. If a download fails, the script reports it, leaves the marker unwritten, and retries on the next run. |

If the user wants the exact files in `font_list.txt`, a mirror is how they get them: they set
`ZCODE_FONT_SOURCE_URL`, and you run the setup script again.

### Install Targets by Platform

Fonts from a mirror are saved to the user font directory:

| Platform | User Font Directory |
|----------|-------------------|
| macOS | `~/Library/Fonts/` |
| Linux | `~/.local/share/fonts/` (then run `fc-cache -f`) |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` (per-user, no admin) |

### Missing Fonts

Where the setup script has supplied no fonts, work with what is installed and add only what the
document needs:

1. **List the installed fonts.** On Linux: `fc-list : family | sort -u`, or `fc-list :lang=zh family`
   for the families that cover Chinese. macOS and Windows ship fonts for both Chinese and Latin text
   (PingFang SC and Songti SC; Microsoft YaHei and SimSun), so there this step usually settles it.
2. **Pick an installed family for each role the document needs**, from the table below. An installed
   family of the same role is a good substitute for a listed one that is absent.
3. **Install from the system's package manager** only when no installed family fills a role, and only
   with the user's confirmation, as the skill's Local-font-first rule requires. Name the package when
   you ask. If there is nobody to ask, or the install fails, continue with the closest installed
   family and say in your result which substitution you made.
4. **On Linux, run `fc-cache -f`** after installing, then confirm with `fc-list` that the family is
   there.

| Role | Families in `font_list.txt` | Debian/Ubuntu package | Arch package |
|------|-----------------------------|-----------------------|--------------|
| Chinese sans-serif | Noto Sans SC | `fonts-noto-cjk` | `noto-fonts-cjk` |
| Chinese serif | Noto Serif SC | `fonts-noto-cjk` | `noto-fonts-cjk` |
| Chinese handwriting (Kai) | LXGW WenKai, LXGW WenKai Mono | `fonts-lxgw-wenkai` | not in the official repositories |
| Chinese monospace | Sarasa Mono SC | not packaged | `ttf-sarasa-gothic` |
| Chinese fallback | WenQuanYi Zen Hei | `fonts-wqy-zenhei` | `wqy-zenhei` |
| Latin, metric-compatible with Arial, Times New Roman and Courier New | Liberation Sans/Serif/Mono, Tinos | `fonts-liberation`, `fonts-croscore` | `ttf-liberation`, `ttf-croscore` |
| Latin, metric-compatible with Calibri | Carlito | `fonts-crosextra-carlito` | `ttf-carlito` |
| Latin and symbol fallback | DejaVu Sans/Serif/Sans Mono, FreeSans/FreeSerif/FreeMono | `fonts-dejavu-core`, `fonts-freefont-ttf` | `ttf-dejavu`, `gnu-free-fonts` |
| Symbols | OpenSymbol | installed with LibreOffice | installed with LibreOffice |

Package names differ between systems. Where a name above does not exist, search the package manager
by family name (`apt-cache search`, `pacman -Ss`, `dnf search`, `brew search font-`) rather than
downloading font files from the web. A package can name a family differently from the file in the
list: the Noto CJK packages install `Noto Sans CJK SC` and `Noto Serif CJK SC`, not `Noto Sans SC`
and `Noto Serif SC`. Use the family name `fc-list` reports.

### Fonts ReportLab Can Embed

ReportLab registers a font by its file path and embeds only fonts with TrueType outlines: static
`.ttf` files (use static-weight files, not variable fonts) and TrueType `.ttc` collections such as
WenQuanYi Zen Hei. It cannot embed CFF-outline fonts, and CFF is what the Noto CJK packages
install. So for Chinese text in a ReportLab PDF, the package to ask for is WenQuanYi Zen Hei; Noto
CJK from the package manager serves the HTML and LaTeX pipelines only.

Ask fontconfig for a font's file and outline format, and register the path it reports. The paths
in `font_list.txt` exist only on a machine laid out that way.

```bash
fc-list : family file fontformat | grep -i "zen hei"
# /usr/share/fonts/.../wqy-zenhei.ttc: WenQuanYi Zen Hei,...:fontformat=TrueType
```

### Post-Install Variable

The setup script sets `FONT_DIR` to the user font directory, where fonts from a mirror are saved.
Fonts that came with the system or its package manager are elsewhere; `fc-list : family file`
gives any installed font's path.

| Platform | FONT_DIR |
|----------|---------------|
| macOS | `~/Library/Fonts` |
| Linux | `~/.local/share/fonts` |
| Windows | `%LOCALAPPDATA%\Microsoft\Windows\Fonts` |

---

## China Network Fallback

If default sources are unreachable, use China mirrors:

### pip (Tsinghua mirror)

```bash
python3 -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple \
  --trusted-host pypi.tuna.tsinghua.edu.cn \
  pikepdf pdfplumber pypdf reportlab PyMuPDF
```

### npm (npmmirror)

```bash
npm install -g playwright@1.50.0 --registry https://registry.npmmirror.com
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
```

### Playwright browser download (npmmirror)

```bash
PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/ npx playwright install chromium
```

### Windows (PowerShell) China mirrors

```powershell
python -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn pikepdf pdfplumber pypdf reportlab PyMuPDF
npm install -g playwright@1.50.0 --registry https://registry.npmmirror.com
# Pinned to 1.50.0 — npmmirror has Chromium rev 1155 for this version
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright/"
npx playwright install chromium
```

### Installer downloads (China)

| Software | China Mirror |
|----------|-------------|
| Node.js | https://npmmirror.com/mirrors/node/ |
| Python | https://npmmirror.com/mirrors/python/ |
| LibreOffice | https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/ |

---

## LibreOffice — Recommended Download Source (Tsinghua TUNA mirror)

**Prefer this mirror over the official libreoffice.org download and over `brew`/`apt`/`winget`
package sources** — it is much faster on Chinese networks and ships the current full build.

- **Recommended base URL:** `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/26.8.0/`
- **If 26.8.0 is gone** (the mirror only keeps a few releases), list
  `https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/` and pick the newest
  version directory, then substitute that version number everywhere below.

### Pick the right package for the platform

Under the version directory, choose the subdirectory matching the OS and CPU architecture:

| Platform | Path under the version dir | Main package |
|----------|---------------------------|--------------|
| Linux x86_64 (Debian/Ubuntu) | `deb/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_deb.tar.gz` |
| Linux ARM64 (Debian/Ubuntu) | `deb/aarch64/` | `LibreOffice_26.8.0_Linux_aarch64_deb.tar.gz` |
| Linux x86_64 (RHEL/Fedora/openSUSE) | `rpm/x86_64/` | `LibreOffice_26.8.0_Linux_x86-64_rpm.tar.gz` |
| macOS Apple Silicon (M1+) | `mac/aarch64/` | `LibreOffice_26.8.0_MacOS_aarch64.dmg` |
| macOS Intel | `mac/x86_64/` | `LibreOffice_26.8.0_MacOS_x86-64.dmg` |
| Windows 64-bit | `win/x86_64/` | `LibreOffice_26.8.0_Win_x86-64.msi` |
| Windows ARM64 | `win/aarch64/` | `LibreOffice_26.8.0_Win_aarch64.msi` |

Determine the architecture with `uname -m` (macOS/Linux: `x86_64` vs `arm64`/`aarch64`) or
`$env:PROCESSOR_ARCHITECTURE` (Windows: `AMD64` vs `ARM64`). The base package is English-only; add
the Chinese UI with the matching `*_langpack_zh-CN.*` file from the same directory if the user wants
a Chinese interface. Help packs (`*_helppack_*`) are optional and not needed for conversion tasks.

### Linux (Debian/Ubuntu) — install from the mirror

```bash
LO_VER=26.8.0
case "$(uname -m)" in x86_64) LO_ARCH=x86_64; LO_TAG=x86-64 ;; aarch64|arm64) LO_ARCH=aarch64; LO_TAG=aarch64 ;; esac
BASE="https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LO_VER/deb/$LO_ARCH"

cd /tmp
curl -fSLO "$BASE/LibreOffice_${LO_VER}_Linux_${LO_TAG}_deb.tar.gz"
tar -xzf "LibreOffice_${LO_VER}_Linux_${LO_TAG}_deb.tar.gz"
sudo dpkg -i LibreOffice_${LO_VER}*/DEBS/*.deb
sudo apt-get install -f -y     # resolve any missing dependencies
soffice --version              # verify (binary lands in /usr/bin or /opt/libreoffice*/program)
```

If `soffice` is not on `PATH` after install, register it — see
*"Register the binary on PATH"* at the end of this section.

`sudo apt install libreoffice-core` from the distro repo remains an acceptable fallback if the
mirror is unreachable — it is older, but sufficient for conversion.

### macOS — install from the mirror

```bash
LO_VER=26.8.0
case "$(uname -m)" in arm64) LO_ARCH=aarch64; LO_TAG=aarch64 ;; x86_64) LO_ARCH=x86_64; LO_TAG=x86-64 ;; esac
BASE="https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LO_VER/mac/$LO_ARCH"

cd /tmp
curl -fSLO "$BASE/LibreOffice_${LO_VER}_MacOS_${LO_TAG}.dmg"
hdiutil attach "LibreOffice_${LO_VER}_MacOS_${LO_TAG}.dmg"
cp -R "/Volumes/LibreOffice/LibreOffice.app" /Applications/
hdiutil detach "/Volumes/LibreOffice"
/Applications/LibreOffice.app/Contents/MacOS/soffice --version   # verify
```

`brew install --cask libreoffice` is the fallback if the mirror is unreachable.

### Windows (PowerShell) — install from the mirror

```powershell
$LoVer = "26.8.0"
$LoArch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
$LoTag  = if ($LoArch -eq "aarch64") { "aarch64" } else { "x86-64" }
$Base = "https://mirrors.tuna.tsinghua.edu.cn/libreoffice/libreoffice/stable/$LoVer/win/$LoArch"
$Msi  = "$env:TEMP\LibreOffice_${LoVer}_Win_${LoTag}.msi"

Invoke-WebRequest -Uri "$Base/LibreOffice_${LoVer}_Win_${LoTag}.msi" -OutFile $Msi
Start-Process msiexec.exe -ArgumentList "/i `"$Msi`" /qn" -Wait   # silent install (needs admin)
& "C:\Program Files\LibreOffice\program\soffice.exe" --version    # verify
```

`winget install TheDocumentFoundation.LibreOffice` is the fallback if the mirror is unreachable.

### Register the binary on PATH (do this immediately after install)

**Do this as part of the install, not as an afterthought.** A LibreOffice that is installed but whose
`soffice` binary is not on the executable search path is indistinguishable from "not installed" to
the next `command -v soffice` probe — which re-triggers the HARD REQUIREMENT and makes you download
several hundred MB you already have. **The mechanism differs per OS; use the one for the platform you
are on.**

Before installing anything, probe first — if the binary already exists somewhere on disk, you need
only the registration step below, **not** a reinstall:

```bash
command -v soffice || ls -d /opt/libreoffice*/program/soffice /Applications/LibreOffice.app/Contents/MacOS/soffice 2>/dev/null
```

```powershell
Get-Command soffice -ErrorAction SilentlyContinue; Test-Path "C:\Program Files\LibreOffice\program\soffice.exe"
```

#### Linux — symlink into a directory already on `PATH`

```bash
sudo ln -sf /opt/libreoffice*/program/soffice /usr/local/bin/soffice
soffice --version   # re-verify: must print a version, not "command not found"
```

If the distro package was used instead of the mirror, `soffice` normally lands in `/usr/bin` already
and no link is needed.

#### macOS — symlink the binary inside the .app bundle

```bash
sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /usr/local/bin/soffice
soffice --version   # re-verify
```

On Apple Silicon, `/usr/local/bin` is not always on `PATH` — if the verify still fails, link into
`/opt/homebrew/bin` instead: `sudo ln -sf /Applications/LibreOffice.app/Contents/MacOS/soffice /opt/homebrew/bin/soffice`.

#### Windows — append the program directory to the user `PATH`

```powershell
$LoDir = "C:\Program Files\LibreOffice\program"
$UserPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($UserPath -notlike "*$LoDir*") { setx PATH "$UserPath;$LoDir" }
```

`setx` only affects **newly launched** shells. For the remainder of the current session, call the
binary by its full path: `& "C:\Program Files\LibreOffice\program\soffice.exe" --version`.

