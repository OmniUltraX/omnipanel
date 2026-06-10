# OmniPanel Shell Integration for PowerShell 7/5
# Emits OSC 133 sequences for command boundary detection (Blocks)
# Compatible with Kitty/WezTerm/Warp shell integration protocol

# 按原生 PowerShell 顺序加载 profile，保留自定义提示符与主题
$__omnipanel_profiles = @(
    $PROFILE.AllUsersAllHosts,
    $PROFILE.AllUsersCurrentHost,
    $PROFILE.CurrentUserAllHosts,
    $PROFILE.CurrentUserCurrentHost
)
foreach ($__omnipanel_profile in $__omnipanel_profiles) {
    if ($__omnipanel_profile -and (Test-Path -LiteralPath $__omnipanel_profile)) {
        try { . $__omnipanel_profile } catch { }
    }
}

function global:OmniPanel-EmitOsc {
    param([string]$Osc)
    [Console]::Write("$([char]27)]$Osc$([char]7)")
}

# Register event handlers for command lifecycle (PowerShell 7+)
# Note: Register-EngineEvent -Action runs in a separate scope,
# so we inline the escape calls instead of referencing functions.
if ($PSVersionTable.PSVersion.Major -ge 7) {
    try {
        $null = Register-EngineEvent -SourceIdentifier PowerShell.PreCommand -Action {
            "$([char]27)]133;C$([char]7)"
        } -ErrorAction Stop

        $null = Register-EngineEvent -SourceIdentifier PowerShell.PostCommand -Action {
            "$([char]27)]133;D;$global:LASTEXITCODE$([char]7)"
        } -ErrorAction Stop
    } catch {
        # PreCommand/PostCommand events not available (no PSReadLine or older build)
        # The prompt-based fallback below will handle it
    }
}

# Save original prompt and replace
if (Test-Path function:\prompt) {
    $function:__omnipanel_orig_prompt = $function:prompt
}
Set-Item -Path function:\global:prompt -Value { global:OmniPanel-Prompt }

function global:OmniPanel-Prompt {
    # Emit prompt start marker
    OmniPanel-EmitOsc "133;A"
    # Report current directory
    OmniPanel-EmitOsc "1337;CurrentDir=$(Get-Location)"

    # Fallback for PowerShell 5 or if engine events didn't fire:
    # Emit command end for the previous command (if any)
    if ($global:__omnipanel_cmd_started) {
        OmniPanel-EmitOsc "133;D;$global:LASTEXITCODE"
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
