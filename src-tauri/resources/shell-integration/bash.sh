# OmniPanel Shell Integration for Bash/Zsh
# Emits OSC 133 sequences for command boundary detection (Blocks)
# Compatible with Kitty/WezTerm/Warp shell integration protocol

__omnipanel_escape() {
  local osc="$1"
  printf "\033]%s\007" "$osc"
}

# Called before each command executes (via DEBUG trap)
__omnipanel_preexec() {
  __omnipanel_escape "133;C"
}

# Called after each command completes
__omnipanel_precmd() {
  local exit_code="$?"
  __omnipanel_escape "133;D;$exit_code"
  __omnipanel_escape "133;A"
  # Report current directory
  __omnipanel_escape "1337;CurrentDir=$(pwd)"
}

# Mark prompt end (user starts typing)
__omnipanel_prompt_start() {
  __omnipanel_escape "133;B"
}

# Bash-specific setup
if [ -n "$BASH_VERSION" ]; then
  # Use PROMPT_COMMAND for precmd
  if [[ -z "$PROMPT_COMMAND" ]]; then
    PROMPT_COMMAND="__omnipanel_precmd"
  else
    PROMPT_COMMAND="__omnipanel_precmd;${PROMPT_COMMAND}"
  fi

  # Use DEBUG trap for preexec
  trap '__omnipanel_preexec' DEBUG

  # Mark prompt boundaries using PS0 (displayed after command read, before execution)
  # and PS1 modification
  __omnipanel_orig_ps1="${PS1:-\$ }"
  PS1='\[\033]133;A\007\]'"${__omnipanel_orig_ps1}"'\[\033]133;B\007\]'
fi

# Zsh-specific setup
if [ -n "$ZSH_VERSION" ]; then
  autoload -Uz add-zsh-hook

  __omnipanel_zsh_precmd() {
    __omnipanel_precmd
  }

  __omnipanel_zsh_preexec() {
    __omnipanel_escape "133;C"
  }

  add-zsh-hook precmd __omnipanel_zsh_precmd
  add-zsh-hook preexec __omnipanel_zsh_preexec

  # Mark prompt start/end
  __omnipanel_orig_prompt="${PROMPT:-%n@%m %~ %# }"
  PROMPT=$'%{\033]133;A\007%}'"${__omnipanel_orig_prompt}"$'%{\033]133;B\007%}'
fi
