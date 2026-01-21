# Analyze Pinecone Metadata - Query sample documents and inspect what's stored
# This script helps identify the indexing gap by examining actual Pinecone data

$webhookUrl = "https://a-i-do.app.n8n.cloud/webhook/chat"

# Simple query to get sample documents - using English for encoding safety
$body = @{
    message = "test query for metadata analysis"
} | ConvertTo-Json -Depth 10

Write-Host "=== Querying Chatbot to Analyze Pinecone Metadata ===" -ForegroundColor Cyan
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri $webhookUrl -Method POST -Body $body -ContentType "application/json; charset=utf-8"

    Write-Host "=== Response Status ===" -ForegroundColor Green
    Write-Host "Success: $($response.success)"
    Write-Host "Match Count: $($response.matchCount)"
    Write-Host ""

    if ($response.sources -and $response.sources.Count -gt 0) {
        Write-Host "=== Source Metadata Analysis ===" -ForegroundColor Yellow
        Write-Host "Number of sources returned: $($response.sources.Count)"
        Write-Host ""

        foreach ($i in 0..($response.sources.Count - 1)) {
            $source = $response.sources[$i]
            Write-Host "--- Source $i ---" -ForegroundColor Magenta
            Write-Host "Title: $($source.title)"
            Write-Host "URL: $($source.url)"
            Write-Host "Score: $($source.score)"

            # Check for additional metadata fields
            $props = $source.PSObject.Properties
            Write-Host "All fields present:" -ForegroundColor Cyan
            foreach ($prop in $props) {
                $val = if ($prop.Value -is [string] -and $prop.Value.Length -gt 100) {
                    "$($prop.Value.Substring(0, 100))... (truncated)"
                } else {
                    $prop.Value
                }
                Write-Host "  - $($prop.Name): $val"
            }
            Write-Host ""
        }

        # Analysis summary
        Write-Host "=== METADATA GAP ANALYSIS ===" -ForegroundColor Red
        $sample = $response.sources[0]

        $requiredFields = @(
            @{Name="database"; Desc="Database source identifier"},
            @{Name="databaseSource"; Desc="Database source (Hebrew)"},
            @{Name="title"; Desc="Document title"},
            @{Name="url"; Desc="PDF URL"},
            @{Name="block"; Desc="Block number (gush)"},
            @{Name="plot"; Desc="Plot number (helka)"},
            @{Name="committee"; Desc="Local committee"},
            @{Name="appraiser"; Desc="Appraiser name"},
            @{Name="caseType"; Desc="Case type"},
            @{Name="decisionDate"; Desc="Decision date"},
            @{Name="year"; Desc="Year for filtering"},
            @{Name="description"; Desc="Full PDF text content"}
        )

        foreach ($field in $requiredFields) {
            $exists = $sample.PSObject.Properties.Name -contains $field.Name
            $value = $sample.($field.Name)
            $hasValue = ![string]::IsNullOrEmpty($value)

            if ($exists -and $hasValue) {
                $valueLen = if ($value -is [string]) { $value.Length } else { "N/A" }
                Write-Host "[OK] $($field.Name): Present (length: $valueLen)" -ForegroundColor Green
            } elseif ($exists) {
                Write-Host "[WARN] $($field.Name): Present but EMPTY" -ForegroundColor Yellow
            } else {
                Write-Host "[MISSING] $($field.Name): $($field.Desc)" -ForegroundColor Red
            }
        }
    } else {
        Write-Host "No sources returned - Pinecone may be empty or query failed" -ForegroundColor Red
    }

    # Check response text for clues
    Write-Host ""
    Write-Host "=== AI Response (first 500 chars) ===" -ForegroundColor Cyan
    if ($response.response -and $response.response.Length -gt 500) {
        Write-Host $response.response.Substring(0, 500)
        Write-Host "..."
    } elseif ($response.response) {
        Write-Host $response.response
    }

    # Output full JSON for detailed analysis
    Write-Host ""
    Write-Host "=== Full Response JSON ===" -ForegroundColor Gray
    $response | ConvertTo-Json -Depth 5

} catch {
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host "Exception details: $($_.Exception.Message)"
}
