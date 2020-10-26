
function toggleModal(modal) {
    modal.classList.toggle("is-active");

    const closeButton = modal.querySelector(".close-button");
    closeButton.addEventListener("click", () => toggleModal(modal));
}

function windowOnClick(event) {
    if (event.target.classList.contains('modal')) {
        toggleModal(modal);
    }
}

window.addEventListener("click", windowOnClick);

window.toggleModal = toggleModal;