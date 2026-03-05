let count = 0;

const countDisplay = document.getElementById("count");
const addBtn = document.getElementById("add-btn");

addBtn.addEventListener("click", () => {
  count++;
  countDisplay.textContent = count;
});
