# wmux Agent Instructions

## Deployment

Use the same deployment path every time unless the user explicitly asks for a different target.

### Common Rules

- Deploy from a committed `master` state. If deployment follows code changes, commit and push first.
- Do not deploy from an ad-hoc copied snapshot.
- Before changing any Tauri CLI flags, check the installed CLI help or current official Tauri v2 docs.
- Keep unrelated dirty files out of commits and deployment steps.

### Linux `.deb` on 0.7

Target:
- Host: `seyeongkim@192.168.0.7`
- Repo: `/home/seyeongkim/Projects/wmux`
- Package: `/home/seyeongkim/Projects/wmux/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb`

Steps:

```powershell
ssh seyeongkim@192.168.0.7 "git -C /home/seyeongkim/Projects/wmux fetch origin master && git -C /home/seyeongkim/Projects/wmux merge --ff-only origin/master"
ssh seyeongkim@192.168.0.7 "cd /home/seyeongkim/Projects/wmux && pnpm install --frozen-lockfile"
ssh seyeongkim@192.168.0.7 "cd /home/seyeongkim/Projects/wmux && pnpm tauri build --bundles deb"
ssh seyeongkim@192.168.0.7 "sudo -n apt-get install -y /home/seyeongkim/Projects/wmux/src-tauri/target/release/bundle/deb/wmux_0.1.0_amd64.deb"
```

Verify:

```powershell
ssh seyeongkim@192.168.0.7 "git -C /home/seyeongkim/Projects/wmux status --short"
ssh seyeongkim@192.168.0.7 "dpkg -s wmux | grep -E '^(Status|Version|Architecture):'"
ssh seyeongkim@192.168.0.7 "which wmux && file /usr/bin/wmux"
```

### Windows Desktop Shortcut

Target:
- Shortcut: `C:\Users\one\Desktop\wmux.lnk`
- Shortcut target: `C:\Users\one\Projects\wmux\src-tauri\target\release\wmux.exe`

Steps:

```powershell
pnpm tauri build --no-bundle
```

If the build fails with `failed to remove file ... wmux.exe` / access denied:

```powershell
tasklist /FI "IMAGENAME eq wmux.exe"
$target = Resolve-Path src-tauri\target\release\wmux.exe
$backup = "$target.bak-$(Get-Date -Format yyyyMMddHHmmss)"
Move-Item -LiteralPath $target -Destination $backup
pnpm tauri build --no-bundle
Remove-Item -LiteralPath $backup
```

Verify:

```powershell
$shortcut = "C:\Users\one\Desktop\wmux.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$target = $lnk.TargetPath
[pscustomobject]@{
  ShortcutTarget = $target
  TargetExists = Test-Path -LiteralPath $target
  TargetLastWriteTime = (Get-Item -LiteralPath $target).LastWriteTime
  Sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash
} | Format-List
```

### Post-Deploy Record

- Record deployment result in `verification.md`.
- Record follow-up notes or manual smoke-test gaps in `feedback.md`.
