-- ~/.config/nvim/lua/brian/plugins/lsp.lua

return {
  {
    "neovim/nvim-lspconfig",
    dependencies = {
      "williamboman/mason.nvim",
      "williamboman/mason-lspconfig.nvim",
    },
    config = function()
      require("mason").setup()

      require("mason-lspconfig").setup({
        ensure_installed = {
          "bashls",
          "lua_ls",
          "ts_ls",
          "eslint",
          "jsonls",
          "yamlls",
          "html",
          "cssls",
          "gopls",
          "rust_analyzer",
        },
      })

      local map = vim.keymap.set

      vim.api.nvim_create_autocmd("LspAttach", {
        callback = function(event)
          local opts = { buffer = event.buf }

          map("n", "gd", vim.lsp.buf.definition, opts)
          map("n", "gr", vim.lsp.buf.references, opts)
          map("n", "K", vim.lsp.buf.hover, opts)
          map("n", "<leader>rn", vim.lsp.buf.rename, opts)
          map("n", "<leader>ca", vim.lsp.buf.code_action, opts)
          map("n", "<leader>f", function()
            vim.lsp.buf.format({ async = true })
          end, opts)
        end,
      })

      vim.lsp.config("lua_ls", {
        settings = {
          Lua = {
            diagnostics = { globals = { "vim" } },
          },
        },
      })

      vim.lsp.enable({
        "bashls",
        "lua_ls",
        "ts_ls",
        "eslint",
        "jsonls",
        "yamlls",
        "html",
        "cssls",
        "ruby_lsp",
        "gopls",
        "rust_analyzer",
      })
    end,
  },
}
