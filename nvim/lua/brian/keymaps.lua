-- ~/.config/nvim/lua/brian/keymaps.lua

local map = vim.keymap.set

local oil_toggle = function()
  -- Check if an Oil buffer is already open
  if vim.bo.filetype == "oil" then
    vim.cmd("q")
  else
    -- Open a vertical split on the left
    vim.cmd("vsplit | vertical resize 35")
    require("oil").open()
  end
end

map("n", "<leader>w", "<cmd>w<cr>", { desc = "Save" })
map("n", "<leader>q", "<cmd>q<cr>", { desc = "Quit" })

map("n", "<leader>ee", "<cmd>Oil<cr>", { desc = "File explorer" })
map("n", "<leader>ea", oil_toggle, { desc = "Toggle Oil Sidebar" })
map("n", "<leader>ff", "<cmd>Telescope find_files<cr>", { desc = "Find files" })
map("n", "<leader>fg", "<cmd>Telescope live_grep<cr>", { desc = "Live grep" })
map("n", "<leader>fb", "<cmd>Telescope buffers<cr>", { desc = "Buffers" })
map("n", "<leader>fh", "<cmd>Telescope help_tags<cr>", { desc = "Help" })

map("n", "<leader>gg", "<cmd>LazyGit<cr>", { desc = "LazyGit" })

-- Better pane movement, compatible with tmux-navigator plugin later.
map("n", "<C-h>", "<C-w>h")
map("n", "<C-j>", "<C-w>j")
map("n", "<C-k>", "<C-w>k")
map("n", "<C-l>", "<C-w>l")
