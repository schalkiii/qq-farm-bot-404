#Requires -Version 7.0
<#
QQ 农场 NapCat 容器的 Windows/WSLC 部署入口，等价于 docker compose 的 napcat profile。

容器内运行的仍是官方 Linux QQ 镜像：登录数据、设备身份与本机 Windows QQ 客户端完全隔离，
不会占用本机 QQ，也不会把农场号写进本机 QQ 的登录记录。

数据目录沿用仓库上级目录的 data/napcat/，与 Docker 部署共用同一份持久化数据；
内部 Token 由容器首次启动生成后通过文件共享给后端，不写入环境变量。
控制台消息沿用 start.bat 的英文 [INFO]/[OK]/[ERROR] 约定，避免 cp936 终端下乱码。
#>
param(
    [ValidateSet('build', 'up', 'down', 'status', 'logs', 'env')]
    [string]$Action = 'up',

    # 基础镜像。直连 Docker Hub 受限时可传镜像加速源全名，脚本会先拉取再构建。
    [string]$BaseImage = 'mlikiowa/napcat-docker:v4.18.19',

    # QQ 登录记录里的设备名称，对应 compose 的 NAPCAT_DEVICE_NAME。
    [string]$DeviceName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = $PSScriptRoot
$ImageName = 'qq-farm-napcat:latest'
$ContainerName = 'qq-farm-napcat'
$WebUiPort = 6099

# 与 docker-compose.yml 保持一致：../data/napcat/{config,QQ,auth}
$DataRoot = Join-Path (Split-Path -Parent $RepoRoot) 'data'
$NapCatData = Join-Path $DataRoot 'napcat'
$ConfigDir = Join-Path $NapCatData 'config'
$QqDataDir = Join-Path $NapCatData 'QQ'
$AuthDir = Join-Path $NapCatData 'auth'
$TokenFile = Join-Path $AuthDir 'token'

# 与 compose 里 napcat 服务相同的 Electron/Chromium 软件渲染参数：
# 无 GPU 的运行环境里禁用 GPU，否则二维码和界面会因 GPU 进程退出而白屏。
$ContainerEnv = [ordered]@{
    NAPCAT_UID                 = '1000'
    NAPCAT_GID                 = '1000'
    ELECTRON_DISABLE_GPU       = '1'
    ELECTRON_ENABLE_LOGGING    = '0'
    LIBGL_ALWAYS_SOFTWARE      = '1'
    QTWEBENGINE_CHROMIUM_FLAGS = '--no-sandbox --disable-gpu --disable-dev-shm-usage --in-process-gpu'
    ELECTRON_EXTRA_LAUNCH_ARGS = '--no-sandbox --disable-gpu --disable-dev-shm-usage'
}

function Get-DeviceName {
    if ($DeviceName) { return $DeviceName }
    if ($env:NAPCAT_DEVICE_NAME) { return $env:NAPCAT_DEVICE_NAME }
    # compose.sh 在 macOS/Linux 取宿主机名，Windows 侧对应 COMPUTERNAME。
    $raw = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { [System.Environment]::MachineName }
    # 设备名只保留字母、数字和连字符，避免 QQ 登录记录出现无法识别的名称。
    $clean = ($raw -replace '[^A-Za-z0-9-]', '-') -replace '-{2,}', '-'
    $clean = $clean.Trim('-')
    if (-not $clean) { $clean = 'QQ-Farm-NapCat' }
    return $clean.Substring(0, [Math]::Min(64, $clean.Length))
}

function Ensure-DataDirs {
    foreach ($dir in @($ConfigDir, $QqDataDir, $AuthDir)) {
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

# wslc 的 stdout 编码不稳定，这里只依赖退出码判断，避免解析文本。
function Test-BaseImage {
    & wslc image inspect $BaseImage *> $null
    return $LASTEXITCODE -eq 0
}

function Test-DerivedImage {
    & wslc image inspect $ImageName *> $null
    return $LASTEXITCODE -eq 0
}

function Test-ContainerExists {
    & wslc container inspect $ContainerName *> $null
    return $LASTEXITCODE -eq 0
}

function Test-ContainerRunning {
    & wslc exec $ContainerName true *> $null
    return $LASTEXITCODE -eq 0
}

function Invoke-PrepareBaseImage {
    if (Test-BaseImage) { return }
    Write-Output "[INFO] Pulling base image $BaseImage"
    & wslc pull $BaseImage
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to pull $BaseImage. Pass -BaseImage with a working registry mirror if Docker Hub is unreachable."
    }
}

function Invoke-Build {
    Invoke-PrepareBaseImage
    Push-Location $RepoRoot
    try {
        Write-Output "[INFO] Building $ImageName with the qq-miniapp-openauth plugin"
        # 复用 napcat/Dockerfile 与 napcat/docker-entrypoint.sh，不另建第二套镜像定义。
        & wslc build --file napcat/Dockerfile --tag $ImageName --build-arg "NAPCAT_IMAGE=$BaseImage" '.'
        if ($LASTEXITCODE -ne 0) { throw "wslc build failed with exit code $LASTEXITCODE" }
        Write-Output '[OK] Image built'
    }
    finally {
        Pop-Location
    }
}

function Get-VolumeArgs {
    # 已实测 WSLC 支持 Windows 路径直接绑定挂载，容器内路径与 compose 完全一致。
    @(
        '--volume', "${ConfigDir}:/app/napcat/config"
        '--volume', "${QqDataDir}:/app/.config/QQ"
        '--volume', "${AuthDir}:/app/napcat-auth"
    )
}

function Get-EnvArgs {
    $envArgs = @()
    foreach ($key in $ContainerEnv.Keys) {
        $envArgs += @('--env', "$key=$($ContainerEnv[$key])")
    }
    return $envArgs
}

function Invoke-Up {
    Ensure-DataDirs
    if (-not (Test-DerivedImage)) { Invoke-Build }
    if (Test-ContainerExists) {
        Write-Output '[INFO] Removing the previous container'
        & wslc container remove --force $ContainerName *> $null
    }

    $device = Get-DeviceName
    Write-Output "[INFO] Starting NapCat with device name $device"
    $runArgs = @(
        'container', 'run', '--detach'
        '--name', $ContainerName
        '--hostname', $device
        '--shm-size', '1g'
        '--publish', "${WebUiPort}:${WebUiPort}"
    ) + (Get-EnvArgs) + (Get-VolumeArgs) + @($ImageName)
    & wslc @runArgs
    if ($LASTEXITCODE -ne 0) { throw "wslc run failed with exit code $LASTEXITCODE" }

    # 首次启动由容器内 entrypoint 生成随机 Token，等文件出现即视为可用。
    # 这里不用 exec 判活：容器刚创建时 exec 还未就绪，会误判为启动失败。
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Path -LiteralPath $TokenFile)) {
        if (-not (Test-ContainerExists)) { throw 'NapCat container exited, run ".\napcat-wslc.ps1 logs" for details' }
        if ((Get-Date) -gt $deadline) { throw 'Container did not create the internal token within 90 seconds, run ".\napcat-wslc.ps1 logs"' }
        Start-Sleep -Milliseconds 500
    }
    Write-Output '[OK] NapCat is up, WebUI published on 127.0.0.1:6099 only'
    Show-BackendEnv
}

function Show-BackendEnv {
    Write-Output ''
    Write-Output '[INFO] Environment required by the backend (start.bat injects it once the token file exists):'
    Write-Output "  NAPCAT_WEBUI_URL=http://127.0.0.1:$WebUiPort/api"
    Write-Output "  NAPCAT_OPENAUTH_URL=http://127.0.0.1:$WebUiPort/plugin/qq-miniapp-openauth/api"
    Write-Output "  NAPCAT_TOKEN_FILE=$TokenFile"
    Write-Output '  Enable the NapCat login switch in the panel instead of forcing it from the environment.'
}

function Invoke-Down {
    if (-not (Test-ContainerExists)) {
        Write-Output '[INFO] No NapCat container found'
        return
    }
    Write-Output '[INFO] Stopping and removing the NapCat container (data stays in data/napcat/)'
    & wslc container stop $ContainerName
    & wslc container remove --force $ContainerName *> $null
    Write-Output '[OK] NapCat container removed'
}

function Invoke-Status {
    Write-Output '== NapCat container =='
    if (Test-ContainerExists) {
        $state = if (Test-ContainerRunning) { 'running' } else { 'created but not ready' }
        Write-Output "  $state"
    }
    else {
        Write-Output '  not created, run ".\napcat-wslc.ps1 up"'
    }
    Write-Output ''
    Write-Output '== Containers =='
    & wslc container list --all
    Write-Output ''
    Write-Output '== Images =='
    & wslc image list
    Write-Output ''
    Write-Output '== Token file =='
    Write-Output "  $TokenFile : $(Test-Path -LiteralPath $TokenFile)"
}

function Invoke-Logs {
    if (-not (Test-ContainerExists)) { throw 'NapCat container is missing, run ".\napcat-wslc.ps1 up" first' }
    & wslc container logs --tail 200 $ContainerName
}

switch ($Action) {
    'build' { Invoke-Build }
    'up' { Invoke-Up }
    'down' { Invoke-Down }
    'status' { Invoke-Status }
    'logs' { Invoke-Logs }
    'env' { Show-BackendEnv }
}
