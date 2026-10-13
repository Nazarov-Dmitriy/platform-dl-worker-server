param([int]$Jobs = 2000)
$ErrorActionPreference = 'Stop'
if ($Jobs -lt 1) { throw 'Jobs must be positive' }
$taskRoot = Split-Path $PSScriptRoot -Parent
$testId = [guid]::NewGuid().ToString('N')
$testVolume = "titunki-stage2-check-$testId"
$testContainer = "titunki-stage2-check-$testId"
$capsPath = Join-Path $taskRoot "tmp\stage2-caps-$testId.json"
New-Item -ItemType Directory -Force -Path (Split-Path $capsPath -Parent) | Out-Null
'[{"code":"media.transcode","recognitionLanguages":[],"translationDirections":[],"autoDetect":false,"formats":["hls"],"availability":"OFFLINE","profilePolicies":["X264_EXACT"]}]' | Set-Content -LiteralPath $capsPath -Encoding utf8NoBOM
function Invoke-TestDocker {
    param([string[]]$DockerArgs)
    $result = & docker @DockerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Docker test operation failed' }
    return $result
}
try {
    Invoke-TestDocker -DockerArgs @('volume','create',$testVolume) | Out-Null
    $seed = @()
    for ($index=0; $index -lt 10; $index++) {
        $site = Invoke-TestDocker -DockerArgs @('run','--rm','-v',"${testVolume}:/data",'titunki-dispatcher:stage2','site-create','-db','/data/dispatcher.db','-name',"test-$index") | ConvertFrom-Json
        $issued = Invoke-TestDocker -DockerArgs @('run','--rm','-v',"${testVolume}:/data",'titunki-dispatcher:stage2','token-issue','-db','/data/dispatcher.db','-purpose','SITE','-id',$site.id) | ConvertFrom-Json
        $seed += @{ id=$site.id; token=$issued.token }
    }
    for ($index=0; $index -lt 20; $index++) {
        Invoke-TestDocker -DockerArgs @('run','--rm','-v',"${testVolume}:/data",'--mount',"type=bind,source=$capsPath,target=/caps.json,readonly",'titunki-dispatcher:stage2','device-create','-db','/data/dispatcher.db','-name',"test-device-$index",'-capabilities','/caps.json') | Out-Null
    }
    Invoke-TestDocker -DockerArgs @('run','-d','--name',$testContainer,'--memory','256m','--cpus','1','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','-v',"${testVolume}:/data",'-p','127.0.0.1::8090','titunki-dispatcher:stage2') | Out-Null
    $published = Invoke-TestDocker -DockerArgs @('port',$testContainer,'8090/tcp')
    $env:DISPATCHER_LOAD_SEED = ConvertTo-Json -InputObject $seed -Compress
    & python (Join-Path $PSScriptRoot 'load-http.py') --url "http://$published" --container $testContainer --jobs $Jobs
    if ($LASTEXITCODE -ne 0) { throw 'HTTP load/restart checks failed' }
} catch {
    & docker logs $testContainer 2>$null
    & docker inspect --format '{{json .State}}' $testContainer 2>$null
    throw
} finally {
    Remove-Item Env:DISPATCHER_LOAD_SEED -ErrorAction SilentlyContinue
    & docker rm -f $testContainer 2>$null | Out-Null
    & docker volume rm $testVolume 2>$null | Out-Null
    # Delete only this invocation's single temporary capability file, never user data.
    if (Test-Path -LiteralPath $capsPath) { Remove-Item -LiteralPath $capsPath }
}
