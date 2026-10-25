$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$synthesizer = $null
try {
    Add-Type -AssemblyName System.Speech
    $synthesizer = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = @($synthesizer.GetInstalledVoices() |
        Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'en' } |
        Sort-Object @{ Expression = {
            if ($_.VoiceInfo.Culture.Name -eq 'en-GB') { 0 }
            elseif ($_.VoiceInfo.Culture.Name -eq 'en-US') { 1 }
            else { 2 }
        } }, @{ Expression = {
            if ($_.VoiceInfo.Name -match 'David') { 0 } else { 1 }
        } }, @{ Expression = { $_.VoiceInfo.Name } })
    if ($voices.Count -eq 0) { throw 'No English speech voice is installed in Windows.' }
    $synthesizer.SelectVoice($voices[0].VoiceInfo.Name)
    $synthesizer.Rate = -1
    $synthesizer.Volume = 100
    $synthesizer.SetOutputToNull()

    while ($null -ne ($line = [Console]::ReadLine())) {
        $request = $null
        try {
            if ($line.Length -gt 4096) { throw 'Speech request is too large.' }
            $request = $line | ConvertFrom-Json
            if ($request.id -isnot [string] -or $request.id.Length -lt 1 -or $request.id.Length -gt 100 -or
                $request.text -isnot [string] -or $request.text.Length -lt 1 -or $request.text.Length -gt 200) {
                throw 'Invalid speech request.'
            }
            $stream = New-Object System.IO.MemoryStream
            try {
                # Synthesis finishes before a byte is returned. Never use the live audio device.
                $synthesizer.SetOutputToWaveStream($stream)
                $synthesizer.Speak([string]$request.text)
                $synthesizer.SetOutputToNull()
                $audio = $stream.ToArray()
                if ($audio.Length -gt 2097152) { throw 'Generated speech is too large.' }
                $response = @{
                    id = $request.id
                    audioBase64 = [Convert]::ToBase64String($audio)
                    voice = $synthesizer.Voice.Name
                    lang = $synthesizer.Voice.Culture.Name
                }
            }
            finally {
                # Release the stream before disposing it, as required by System.Speech.
                $synthesizer.SetOutputToNull()
                $stream.Dispose()
            }
        }
        catch {
            $errorText = [string]$_.Exception.Message
            if ($errorText.Length -gt 500) { $errorText = $errorText.Substring(0, 500) }
            $response = @{ id = $request.id; error = $errorText }
        }
        [Console]::WriteLine(($response | ConvertTo-Json -Compress -Depth 4))
        [Console]::Out.Flush()
    }
}
catch {
    [Console]::Error.WriteLine('The Windows speech worker could not initialize.')
    exit 1
}
finally {
    if ($null -ne $synthesizer) { $synthesizer.Dispose() }
}
