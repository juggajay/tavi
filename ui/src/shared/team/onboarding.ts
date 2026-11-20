export function phoneWelcome(): HTMLElement {
  const screen = document.createElement("section"); screen.className = "team-first-conversation";
  screen.setAttribute("aria-label", "Finish setting up Tavi");
  const title = document.createElement("h1"); title.textContent = "A little hello on your PC first";
  const text = document.createElement("p"); text.textContent = "Open Tavi on the PC to choose your main bot, sign in and choose a safety PIN. Your place is kept there. Then come back here to talk to the same team.";
  const hint = document.createElement("p"); hint.textContent = "Once that is done, you can keep getting to know your main bot here by typing or talking.";
  screen.append(title, text, hint); return screen;
}
