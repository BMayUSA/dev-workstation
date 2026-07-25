local lazypath = vim.fn.stdpath("data") .. "/lazy/lazy.nvim"

if not vim.uv.fs_stat(lazypath) then
  vim.fn.system({
    "git",
    "clone",
    "--filter=blob:none",
    "https://github.com/folke/lazy.nvim.git",
    "--branch=stable",
    lazypath,
  })
end

vim.opt.rtp:prepend(lazypath)

require("lazy").setup({
  { import = "brian.plugins.ui" },
  { import = "brian.plugins.editor" },
  { import = "brian.plugins.treesitter" },
  { import = "brian.plugins.git" },
  { import = "brian.plugins.lsp" },
  { import = "brian.plugins.completion" },
})
