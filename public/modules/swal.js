import { loadScript } from './dom.js';

const SWAL_SRC = '/assets/sweetalert2.all.min.js';

export async function swalAlert(title, text, icon = 'info') {
    try {
        await loadScript(SWAL_SRC);
        return Swal.fire({ title, text: text || '', icon, scrollbarPadding: false });
    } catch (e) {
        console.error(e);
        window.alert(`${title}${text ? '\n' + text : ''}`);
        return { isConfirmed: true };
    }
}

export async function swalConfirm(title, text) {
    try {
        await loadScript(SWAL_SRC);
        const result = await Swal.fire({
            title,
            text: text || '',
            icon: 'warning',
            scrollbarPadding: false,
            showCancelButton: true,
            confirmButtonText: 'Confirm',
            cancelButtonText: 'Cancel'
        });
        return result.isConfirmed;
    } catch (e) {
        console.error(e);
        return window.confirm(`${title}${text ? '\n' + text : ''}`);
    }
}

export async function swalUnsaved(saveCallback) {
    try {
        await loadScript(SWAL_SRC);
        const result = await Swal.fire({
            title: 'Unsaved Changes',
            icon: 'warning',
            scrollbarPadding: false,
            showDenyButton: true,
            showCancelButton: true,
            confirmButtonText: 'Save',
            denyButtonText: 'Discard',
            cancelButtonText: 'Cancel'
        });
        if (result.isConfirmed) return await saveCallback();
        if (result.isDenied) return true;   // discard
        return false;                       // cancel
    } catch (e) {
        console.error(e);
        const wantSave = window.confirm('Save changes? OK=Save, Cancel=Choose discard/stay');
        if (wantSave) return await saveCallback();
        return window.confirm('Discard changes? OK=Discard, Cancel=Stay');
    }
}
