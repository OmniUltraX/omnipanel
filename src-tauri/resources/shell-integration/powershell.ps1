# OmniPanel Shell Integration for PowerShell 7/5
# Emits OSC 133 sequences for command boundary detection (Blocks)
# Compatible with Kitty/WezTerm/Warp shell integration protocol

function global:OmniPanel-Escape {
    param([string]$Osc)
    "$([char]27)]$Osc$([char]7)"
}

function global:OmniPanel-PreCommand {
    # Command is about to execute — emit output start
    # At this point the command text is still on the current line
    OmniPanel-Escape "133;C"
}

function global:OmniPanel-PostCommand {
    param(
        [int]$LastExitCode = $global:LASTEXITCODE
    )
    # Command finished — emit exit code
    OmniPanel-Escape "133;D;$LastExitCode"
}

# Register event handlers for command lifecycle (PowerShell 7+)
if ($PSVersionTable.PSVersion.Major -ge 7) {
    $null = Register-EngineEvent -SourceIdentifier PowerShell.PreCommand -Action {
        global:OmniPanel-PreCommand
    } -ErrorAction SilentlyContinue

    $null = Register-EngineEvent -SourceIdentifier PowerShell.PostCommand -Action {
        global:OmniPanel-PostCommand
    } -ErrorAction SilentlyContinue
}

# Save original prompt and replace
if (Test-Path function:\prompt) {
    $function:__omnipanel_orig_prompt = $function:prompt
}
Set-Item -Path function:\global:prompt -Value { global:OmniPanel-Prompt }

function global:OmniPanel-Prompt {
    # Emit prompt start marker
    OmniPanel-Escape "133;A"
    # Report current directory
    OmniPanel-Escape "1337;CurrentDir=$(Get-Location)"

    # Fallback for PowerShell 5 or if engine events didn't fire:
    # Emit command end for the previous command (if any)
    if ($global:__omnipanel_cmd_started) {
        OmniPanel-Escape "133;D;$global:LASTEXITCODE"
        $global:__omnipanel_cmd_started = $false
    }

    # Call original prompt if it exists, otherwise use default
    $promptText = if ($function:__omnipanel_orig_prompt) {
        & $function:__omnipanel_orig_prompt
    } else {
        "PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) "
    }

    # Mark that a command cycle is active (for fallback exit code emission)
    $global:__omnipanel_cmd_started = $true

    $promptText
}

# Mark initial prompt
OmniPanel-Escape "133;A"
OmniPanel-Escape "1337;CurrentDir=$(Get-Location)"
