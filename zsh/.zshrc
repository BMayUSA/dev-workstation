
# If you come from bash you might have to change your $PATH.
# export PATH=$HOME/bin:/usr/local/bin:$PATH

# Path to your oh-my-zsh installation.
export ZSH="$HOME/.oh-my-zsh"

# Set name of the theme to load --- if set to "random", it will
# load a random theme each time oh-my-zsh is loaded, in which case,
# to know which specific one was loaded, run: echo $RANDOM_THEME
# See https://github.com/robbyrussell/oh-my-zsh/wiki/Themes
#ZSH_THEME="avit"

# Uncomment the following line to use hyphen-insensitive completion.
# Case-sensitive completion must be off. _ and - will be interchangeable.
HYPHEN_INSENSITIVE="true"

# Uncomment the following line to disable auto-setting terminal title.
# DISABLE_AUTO_TITLE="true"

# Uncomment the following line to enable command auto-correction.
# ENABLE_CORRECTION="true"

# Uncomment the following line to display red dots whilst waiting for completion.
# COMPLETION_WAITING_DOTS="true"

# Uncomment the following line if you want to change the command execution time
# stamp shown in the history command output.
# You can set one of the optional three formats:
# "mm/dd/yyyy"|"dd.mm.yyyy"|"yyyy-mm-dd"
# or set a custom format using the strftime function format specifications,
# see 'man strftime' for details.
# HIST_STAMPS="mm/dd/yyyy"
setopt share_history

# Would you like to use another custom folder than $ZSH/custom?
# ZSH_CUSTOM=/path/to/new-custom-folder

# Which plugins would you like to load?
# Standard plugins can be found in ~/.oh-my-zsh/plugins/*
# Custom plugins may be added to ~/.oh-my-zsh/custom/plugins/
# Example format: plugins=(rails git textmate ruby lighthouse)
# Add wisely, as too many plugins slow down shell startup.

plugins=(evalcache git)

export ANDROID_HOME="$HOME/Library/Android/sdk"
export REVDIFF_VIM_MOTION=1

# Deduplicate path entries when re-sourcing
typeset -U path PATH
path=(
  "$HOME/.local/bin"
  "$HOME/tools"
  "$ANDROID_HOME/emulator"
  "$ANDROID_HOME/platform-tools"
  "/Applications/Docker.app/Contents/Resources/bin"
  $path
)
export PATH

source $ZSH/oh-my-zsh.sh

# You may need to manually set your language environment
# export LANG=en_US.UTF-8

[[ -f "${ZSH_DIR}/profiles/${ZSH_PROFILE}.rc.zsh" ]] && source "${ZSH_DIR}/profiles/${ZSH_PROFILE}.rc.zsh"

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
 export EDITOR='vim'
else
 export EDITOR='nvim'
fi

# eval "$(direnv hook zsh)"
_evalcache direnv hook zsh

# eval "$(~/.local/bin/mise activate zsh)"
_evalcache ~/.local/bin/mise activate zsh

# eval "$(zoxide init zsh)"
_evalcache zoxide init zsh

# Load custom zsh functions
fpath+=("$HOME/.zsh_funcs")
autoload -Uz branchdiff toBinary fromBinary listening extract qrcode

# Set personal aliases, overriding those provided by oh-my-zsh libs,
# plugins, and themes. Aliases can be placed here, though oh-my-zsh
# users are encouraged to define aliases within the ZSH_CUSTOM folder.
# For a full list of active aliases, run `alias`.
#
# alias zshconfig="source ~/.zshrc"
alias python="python3"
alias be="bundle exec"
alias k="kubectl"
alias dps="docker ps --format '{{.Names}}\n\tContainer ID: {{.ID}}\n\tCommand: {{.Command}}\n\tImage: {{.Image}}\n\tCreatedAt: {{.CreatedAt}}\n\tStatus: {{.Status}}'"

# vim keybindings
bindkey -v

# Vim Mode in Prompt
VIM_INS_MODE="%F{green}I%f"
VIM_CMD_MODE="%F{blue}N%f"
function zle-keymap-select {
  VIM_MODE="${${KEYMAP}/vicmd/${VIM_CMD_MODE}}"
  VIM_MODE="${${VIM_MODE}/(main|viins)/${VIM_INS_MODE}}"
  zle reset-prompt
}
zle -N zle-keymap-select
function zle-line-init {
  VIM_MODE="${VIM_INS_MODE}"
  zle reset-prompt
}
zle -N zle-line-init

# Prompt Config
autoload -Uz vcs_info
precmd() { vcs_info }
zstyle ':vcs_info:git:*' formats '%b'
setopt PROMPT_SUBST
NEWLINE=$'\n'
PROMPT='%F{green}%*%f %F{blue}%3~%f %F{red}${vcs_info_msg_0_}%f${NEWLINE}${VIM_MODE}$ '

# ZSH-Syntax-Highlighting plugin
source /opt/homebrew/Cellar/zsh-syntax-highlighting/0.8.0/share/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh
ZSH_HIGHLIGHT_HIGHLIGHTERS=(main brackets pattern cursor)
ZSH_HIGHLIGHT_STYLES[path]='fg=green'
ZSH_HIGHLIGHT_STYLES[unknown-token]='fg=red'


# Updates PATH for the Google Cloud SDK.
if [ -f '$HOME/tools/google-cloud-sdk/path.zsh.inc' ]; then . '$HOME/tools/google-cloud-sdk/path.zsh.inc'; fi
# Enables shell command completion for gcloud.
if [ -f '$HOME/tools/google-cloud-sdk/completion.zsh.inc' ]; then . '$HOME/tools/google-cloud-sdk/completion.zsh.inc'; fi

. "$HOME/.local/bin/env"
# Enable Docker CLI completions.
fpath=($HOME/.docker/completions $fpath)


# fzf for shell history search
source <(fzf --zsh)

autoload -Uz compinit
compinit

# Setup Zoxide - must be after compinit
eval "$(zoxide init zsh)"

