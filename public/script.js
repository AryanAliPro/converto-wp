/* ========== NAVIGATION ========== */
const navToggle = document.getElementById('nav-toggle');
const navMobileMenu = document.getElementById('nav-mobile-menu');

if (navToggle && navMobileMenu) {
    navToggle.addEventListener('click', () => {
        navMobileMenu.classList.toggle('open');
    });

    navMobileMenu.querySelectorAll('a').forEach(link => {
        link.addEventListener('click', () => {
            navMobileMenu.classList.remove('open');
        });
    });
}

/* ========== SMOOTH SCROLL FOR ANCHOR LINKS ========== */
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});

/* ========== NAV BACKGROUND ON SCROLL ========== */
const siteNav = document.getElementById('site-nav');
if (siteNav) {
    window.addEventListener('scroll', () => {
        if (window.scrollY > 20) {
            siteNav.style.background = 'rgba(5, 5, 8, 0.95)';
        } else {
            siteNav.style.background = 'rgba(5, 5, 8, 0.8)';
        }
    }, { passive: true });
}

/* ========== SCROLL REVEAL ANIMATION ========== */
const observerOptions = {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px'
};

const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            entry.target.style.opacity = '1';
            entry.target.style.transform = 'translateY(0)';
            revealObserver.unobserve(entry.target);
        }
    });
}, observerOptions);

document.querySelectorAll('.feature-card, .how-step, .platform-card, .comparison-item, .faq-item').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
    revealObserver.observe(el);
});

/* ========== CONVERTER TOOL FUNCTIONALITY ========== */
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('lovable_zip');
const uploadBtn = document.getElementById('upload-btn');
const uploadSection = document.getElementById('upload-section');
const progressSection = document.getElementById('progress-section');
const successSection = document.getElementById('success-section');
const consoleOutput = document.getElementById('console');
const downloadLink = document.getElementById('download-link');
const conversionProgressContainer = document.getElementById('conversion-progress');
const conversionProgressFill = document.getElementById('conversion-progress-fill');
const conversionProgressText = document.getElementById('conversion-progress-text');

let selectedFile = null;

// Handle Drag and Drop
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, unhighlight, false);
});

dropZone.addEventListener('drop', handleDrop, false);

// Handle file selection via clicking
fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
        handleFiles(fileInput.files);
    }
});

function highlight() {
    dropZone.classList.add('dragover');
}

function unhighlight() {
    dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    handleFiles(files);
}

function handleFiles(files) {
    if (files.length > 0 && files[0].name.endsWith('.zip')) {
        selectedFile = files[0];
        const p = dropZone.querySelector('p');
        const h3 = dropZone.querySelector('h3');

        h3.textContent = 'Ready to Upload';
        h3.classList.add('selected-file');
        p.textContent = selectedFile.name;
        p.style.color = 'var(--text-primary)';
        p.style.fontWeight = '500';

        const dt = new DataTransfer();
        dt.items.add(selectedFile);
        fileInput.files = dt.files;

        uploadBtn.disabled = false;
    } else {
        alert('Please select a valid .zip file');
    }
}

// Handle Upload / Start Conversion pipeline
uploadBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    uploadSection.classList.add('hidden');
    progressSection.classList.remove('hidden');

    const formData = new FormData();
    formData.append('lovable_zip', selectedFile);

    const selectedPlatform = document.querySelector('input[name="platform"]:checked').value;
    formData.append('platform', selectedPlatform);

    try {
        const response = await fetch('/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error('Upload failed');

        const data = await response.json();
        const taskId = data.taskId;

        const eventSource = new EventSource(`/events/${taskId}`);

        eventSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            const logLine = document.createElement('div');
            logLine.className = 'log-line';
            logLine.textContent = data.step > 0
                ? `> Step ${data.step}: ${data.message}`
                : `> ${data.message}`;
            consoleOutput.appendChild(logLine);
            consoleOutput.scrollTop = consoleOutput.scrollHeight;

            if (data.step > 0) {
                updateStepsUI(data.step);
            }

            if (data.progress !== undefined && data.progress !== null) {
                conversionProgressContainer.classList.remove('hidden');
                conversionProgressFill.style.width = `${data.progress}%`;
                conversionProgressText.innerText = `${data.progress}%`;
            }
        };

        eventSource.addEventListener('complete', (event) => {
            const data = JSON.parse(event.data);
            eventSource.close();

            progressSection.classList.add('hidden');
            successSection.classList.remove('hidden');

            downloadLink.href = `/download?token=${encodeURIComponent(data.downloadToken)}`;
            downloadLink.download = data.themeName;
        });

        eventSource.addEventListener('error', (event) => {
            eventSource.close();
            const data = JSON.parse(event.data);
            alert(`Pipeline Error: ${data.error}`);
            location.reload();
        });

    } catch (error) {
        alert(`Error starting agent: ${error.message}`);
        location.reload();
    }
});

function updateStepsUI(currentStep) {
    for (let i = 1; i <= 5; i++) {
        const el = document.getElementById(`step-${i}`);
        if (i < currentStep) {
            el.className = 'step completed';
            el.querySelector('.step-icon').innerHTML = '&#10003;';
        } else if (i === currentStep) {
            el.className = 'step active';
        }
    }
}
