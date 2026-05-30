# OmniPanel Shell Integration for Bash/Zsh
# Emits OSC 133 sequences for command boundary detection (Blocks)

# 先加载用户配置，保留与原生终端一致的 PS1 / 主题
if [[ -f "${HOME}/.bashrc" ]]; then
    # shellcheck disable=SC1090
    . "${HOME}/.bashrc"
fi

__omnipanel_prompt_start() {
    printf "\033]133;A\007"
    printf "\033]1337;CurrentDir=%s\007" "$PWD"
}

__omnipanel_prompt_end() {
    printf "\033]133;B\007"
}

__omnipanel_cmd_start() {
    printf "\033]133;C\007"
}

__omnipanel_cmd_end() {
    printf "\033]133;D;%s\007" "$?"
}

if [[ -n "${BASH_VERSION:-}" ]]; then
    # Bash: use PROMPT_COMMAND and DEBUG trap
    __omnipanel_orig_prompt="${PROMPT_COMMAND:-}"
    PROMPT_COMMAND="__omnipanel_cmd_end; __omnipanel_prompt_start; ${__omnipanel_orig_prompt}"
    trap '__omnipanel_cmd_start' DEBUG
elif [[ -n "${ZSH_VERSION:-}" ]]; then
    # Zsh: use precmd and preexec hooks
    autoload -Uz add-zsh-hook 2>/dev/null
    add-zsh-hook precmd __omnipanel_prompt_start
    add-zsh-hook precmd __omnipanel_cmd_end
    add-zsh-hook preexec __omnipanel_cmd_start
fi
