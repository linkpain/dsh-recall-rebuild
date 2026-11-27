Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | Format-List
Write-Output "=== node/electron children ==="
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'dsh' -and $_.Name -ne 'DeepSeek Harness.exe' } | Select-Object ProcessId,Name,CommandLine | Format-List
