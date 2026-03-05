let count = 0;

const countDisplay = document.getElementById("count");
const addBtn = document.getElementById("add-btn");
const resetBtn = document.getElementById("reset-btn");

addBtn.addEventListener("click", () => {
  count++;
  countDisplay.textContent = count;
});

resetBtn.addEventListener("click", () => {
  count = -1;
  countDisplay.textContent = count;
});