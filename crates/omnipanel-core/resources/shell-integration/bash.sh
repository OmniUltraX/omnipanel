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

__omnipanel_is_history_sync() {
    case "${BASH_COMMAND:-}" in
        __omnipanel_history_sync__|__omnipanel_emit_history*) return 0 ;;
    esac
    return 1
}

__omnipanel_cmd_start() {
    __omnipanel_is_history_sync && return
    printf "\033]133;C\007"
}

# 退出码必须由调用方在回调最开头捕获后传入：
# 函数内的赋值与 `cmd && return` 短路都会覆盖 $?，直接读取会得到固定值。
__omnipanel_cmd_end() {
    local __ec="${1:-0}"
    __omnipanel_is_history_sync && return
    printf "\033]133;D;%s\007" "$__ec"
}

__omnipanel_emit_history() {
    local max="${1:-5000}"
    export HISTCONTROL="${HISTCONTROL:+${HISTCONTROL}:}ignorespace"
    local histfile="${HISTFILE:-$HOME/.bash_history}"
    if [[ -f "$histfile" ]]; then
        local blob chunk_size=8192 len pos=0
        blob=$(tail -n "$max" "$histfile" | base64 -w0 2>/dev/null || tail -n "$max" "$histfile" | base64 | tr -d '\n')
        len=${#blob}
        while (( pos < len )); do
            printf '\033]1337;HistoryPart;%s\007' "${blob:pos:chunk_size}"
            pos=$((pos + chunk_size))
        done
    fi
    printf '\033]1337;HistoryBlobEnd\007'
}

alias __omnipanel_history_sync__='__omnipanel_emit_history 5000'

if [[ -n "${BASH_VERSION:-}" ]]; then
    # Bash: use PROMPT_COMMAND with a single callback + DEBUG trap
    __omnipanel_orig_prompt="${PROMPT_COMMAND:-}"
    __omnipanel_in_prompt=0
    __omnipanel_prompt_callback() {
        local __ec=$?
        __omnipanel_in_prompt=1
        __omnipanel_cmd_end "$__ec"
        __omnipanel_prompt_start
        ${__omnipanel_orig_prompt}
        case "${BASH_COMMAND:-}" in
            __omnipanel_history_sync__|__omnipanel_emit_history*)
                history -d "$((HISTCMD - 1))" 2>/dev/null || true
                ;;
        esac
        __omnipanel_in_prompt=0
    }
    PROMPT_COMMAND="__omnipanel_prompt_callback"
    trap '(( __omnipanel_in_prompt == 0 )) && __omnipanel_cmd_start' DEBUG
elif [[ -n "${ZSH_VERSION:-}" ]]; then
    # Zsh: use precmd and preexec hooks
    autoload -Uz add-zsh-hook 2>/dev/null
    __omnipanel_zsh_preexec() {
        [[ "$1" == "__omnipanel_history_sync__" ]] && return
        __omnipanel_cmd_start
    }
    # 合并为单个 precmd：首行捕获退出码（prompt_start 的 printf 会覆盖 $?），
    # 且顺序必须是先 D（上条命令结束）后 A（新提示符开始）。
    __omnipanel_zsh_precmd() {
        local __ec=$?
        __omnipanel_cmd_end "$__ec"
        __omnipanel_prompt_start
    }
    add-zsh-hook precmd __omnipanel_zsh_precmd
    add-zsh-hook preexec __omnipanel_zsh_preexec
fi
