## Setup

Backup existing zsh config if necessary:

- `mv $HOME/.zshrc $HOME/.zshrc.bak`
- `mv $HOME/.zsh_funcs $HOME/.zsh_funcs.bak`

Symlink source config to expected destination:

- `ln -s $(pwd)/zsh/.zshrc $HOME/.zshrc`
- `ln -s $(pwd)/zsh/.zsh_funcs $HOME/.zsh_funcs`

