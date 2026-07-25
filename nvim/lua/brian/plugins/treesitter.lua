-- lua/brian/plugins/treesitter.lua

local ensure_installed = {
  "bash",
  "css",
  "dockerfile",
  "html",
  "javascript",
  "json",
  "lua",
  "markdown",
  "markdown_inline",
  "typescript",
  "tsx",
  "vim",
  "yaml",
}

local highlighted_filetypes = {
  "css",
  "dockerfile",
  "html",
  "javascript",
  "javascriptreact",
  "json",
  "lua",
  "markdown",
  "sh",
  "typescript",
  "typescriptreact",
  "vim",
  "yaml",
}

return {
  {
    "nvim-treesitter/nvim-treesitter",
    branch = "main",
    lazy = false,
    build = ":TSUpdate",
    config = function()
      require("nvim-treesitter").install(ensure_installed)

      vim.api.nvim_create_autocmd("FileType", {
        pattern = highlighted_filetypes,
        callback = function(args)
          vim.treesitter.start(args.buf)
          vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
        end,
        desc = "Enable Tree-sitter highlighting and indentation",
      })
    end,
  },
}
