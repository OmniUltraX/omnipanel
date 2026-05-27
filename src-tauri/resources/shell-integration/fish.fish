# OmniPanel Shell Integration for Fish
# Emits OSC 133 sequences for command boundary detection (Blocks)
# Compatible with Kitty/WezTerm/Warp shell integration protocol

function __omnipanel_escape
    printf "\033]%s\007" $argv[1]
end

function __omnipanel_preexec --on-event fish_preexec
    # Mark command output start (command is about to execute)
    __omnipanel_escape "133;C"
end

function __omnipanel_postexec --on-event fish_postexec
    set -l exit_code $status
    # Mark command end with exit code
    __omnipanel_escape "133;D;$exit_code"
end

function __omnipanel_prompt --on-event fish_prompt
    # Mark prompt start
    __omnipanel_escape "133;A"
    # Report current directory
    __omnipanel_escape "1337;CurrentDir=$(pwd)"
end

function __omnipanel_preexec_line --on-event fish_preexec
    # This fires after user presses Enter but before command runs
    __omnipanel_escape "133;B"
end

# Mark initial prompt
__omnipanel_escape "133;A"
__omnipanel_escape "133;B"
__omnipanel_escape "1337;CurrentDir=$(pwd)"
