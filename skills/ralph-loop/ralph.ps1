param(
    [int]$MaxIterations = 10,
    [int]$SleepSeconds = 2
)

Write-Host "Starting Ralph agent - maximum $MaxIterations cycles"
Write-Host ""

$promptFile = Join-Path $PSScriptRoot "ralph-prompt.txt"
$promptText = Get-Content $promptFile -Raw

for ($i = 1; $i -le $MaxIterations; $i++) {
    Write-Host "==========================================="
    Write-Host "  Cycle $i of $MaxIterations"
    Write-Host "==========================================="

    $result = claude --dangerously-skip-permissions --output-format text -p $promptText

    Write-Host $result
    Write-Host ""

    if ($result -like "*<promise>COMPLETE</promise>*") {
        Write-Host "==========================================="
        Write-Host "  All tasks completed after $i cycles"
        Write-Host "==========================================="
        exit 0
    }

    Start-Sleep -Seconds $SleepSeconds
}

Write-Host "==========================================="
Write-Host "  Stopped after reaching limit ($MaxIterations)"
Write-Host "==========================================="
exit 1
