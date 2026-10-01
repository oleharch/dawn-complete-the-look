/**
 * <complete-the-look>
 *
 * 1. Listens for `submit` of the main product form (document, capture phase, so it runs before
 *    the theme's own handler and survives the theme re-rendering the product form).
 * 2. Re-renders this section for the selected variant through the Section Rendering API
 *    and opens the native <dialog>. Prices, images and texts all come from Liquid.
 * 3. "Add selected": one POST to /cart/add.js with `items` (the product with its quantity,
 *    selling plan and properties, plus every checked pick) and `sections` from the theme's
 *    cart drawer or notification, then hands the response to that element's renderContents().
 * 4. "Add only this item": lets the original submit through, so the theme adds it as usual.
 *
 * Whenever something is off (no picks, a network error, file uploads in the form) the submit
 * goes through untouched: the modal never blocks a purchase.
 */
if (!customElements.get('complete-the-look')) {
  class CompleteTheLook extends HTMLElement {
    constructor() {
      super();
      this.onSubmit = this.onSubmit.bind(this);
      this.onClick = this.onClick.bind(this);
      this.onChange = this.onChange.bind(this);
      this.onSectionSelect = this.onSectionSelect.bind(this);
      this.onSectionDeselect = this.onSectionDeselect.bind(this);
    }

    connectedCallback() {
      this.dialog = this.querySelector('dialog');
      this.dialog.addEventListener('click', this.onClick);
      this.dialog.addEventListener('change', this.onChange);

      if (this.dataset.designMode === 'true') {
        document.addEventListener('shopify:section:select', this.onSectionSelect);
        document.addEventListener('shopify:section:deselect', this.onSectionDeselect);
        return;
      }
      document.addEventListener('submit', this.onSubmit, true);
    }

    disconnectedCallback() {
      document.removeEventListener('submit', this.onSubmit, true);
      document.removeEventListener('shopify:section:select', this.onSectionSelect);
      document.removeEventListener('shopify:section:deselect', this.onSectionDeselect);
    }

    /* ---------- intercept ---------- */

    isMainProductForm(form) {
      return (
        form instanceof HTMLFormElement &&
        form.matches('form[action*="/cart/add"]') &&
        form.querySelector(`input[name="product-id"][value="${this.dataset.productId}"]`) &&
        !form.closest('dialog, quick-add-modal, modal-dialog, complete-the-look')
      );
    }

    shouldOpen(form) {
      if (this.dataset.enabled !== 'true' || Number(this.dataset.picks) === 0) return false;
      if (this.dataset.oncePerSession === 'true' && this.wasShown()) return false;
      // JSON cannot carry file uploads (line item properties with files): let the theme handle those.
      const hasFiles = [...new FormData(form).values()].some((value) => value instanceof File && value.size > 0);
      return !hasFiles;
    }

    onSubmit(event) {
      const form = event.target;
      if (!this.isMainProductForm(form)) return;
      if (this.passThrough) {
        this.passThrough = false;
        return;
      }
      if (!this.shouldOpen(form)) return;

      event.preventDefault();
      event.stopImmediatePropagation();
      this.form = form;
      this.submitter = event.submitter;
      this.open();
    }

    /* Hand the original submit back to the theme (its own handler adds to cart as usual). */
    letThrough() {
      if (!this.form) return;
      this.passThrough = true;
      this.form.requestSubmit(this.submitter && this.submitter.form === this.form ? this.submitter : undefined);
    }

    /* ---------- open ---------- */

    async open() {
      const variantId = new FormData(this.form).get('id');
      this.setButtonLoading(true);
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('variant', variantId);
        url.searchParams.set('section_id', this.dataset.sectionId);
        const response = await fetch(url, { headers: { Accept: 'text/html' } });
        if (!response.ok) throw new Error(`Section request failed: ${response.status}`);
        const html = new DOMParser().parseFromString(await response.text(), 'text/html');
        const fresh = html.querySelector('complete-the-look dialog');
        if (!fresh || !fresh.querySelector('[data-ctl-pick]')) {
          this.setButtonLoading(false);
          this.letThrough();
          return;
        }
        this.dialog.innerHTML = fresh.innerHTML;
        this.setButtonLoading(false);
        this.showDialog();
      } catch (error) {
        console.error('[complete-the-look]', error);
        this.setButtonLoading(false);
        this.letThrough();
      }
    }

    showDialog() {
      this.hideError();
      if (!this.dialog.open) this.dialog.showModal();
      this.rememberShown();
    }

    close() {
      if (this.dialog.open) this.dialog.close();
    }

    /* ---------- dialog actions ---------- */

    onClick(event) {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-ctl-add-selected')) this.addSelected(button);
      if (button.hasAttribute('data-ctl-add-main')) {
        this.close();
        this.letThrough();
      }
    }

    /* A pick's variant select updates its price and SKU from data rendered by Liquid. */
    onChange(event) {
      const select = event.target.closest('select[data-ctl-variant]');
      if (!select) return;
      const option = select.selectedOptions[0];
      const pick = select.closest('[data-ctl-pick]');
      const price = pick.querySelector('[data-ctl-price]');
      const sku = pick.querySelector('[data-ctl-sku]');
      price.replaceChildren();
      const current = document.createElement('span');
      current.textContent = option.dataset.price;
      price.append(current);
      if (option.dataset.compareAtPrice) {
        const compare = document.createElement('s');
        compare.textContent = option.dataset.compareAtPrice;
        price.append(compare);
      }
      if (sku) sku.textContent = option.dataset.sku || '';
    }

    /* Build the main line item from the theme's form, so quantity, selling plan and properties are kept. */
    mainItem() {
      const data = new FormData(this.form);
      const item = { id: Number(data.get('id')), quantity: Math.max(1, Number(data.get('quantity')) || 1) };
      if (data.get('selling_plan')) item.selling_plan = Number(data.get('selling_plan'));
      const properties = {};
      for (const [key, value] of data.entries()) {
        const match = key.match(/^properties\[(.+)\]$/);
        if (match && typeof value === 'string' && value !== '') properties[match[1]] = value;
      }
      if (Object.keys(properties).length) item.properties = properties;
      return item;
    }

    selectedPicks() {
      return [...this.dialog.querySelectorAll('[data-ctl-pick]')]
        .filter((pick) => pick.querySelector('[data-ctl-pick-check]').checked)
        .map((pick) => ({ id: Number(pick.querySelector('[data-ctl-variant]').value), quantity: 1 }));
    }

    async addSelected(button) {
      const cart = document.querySelector('cart-drawer') || document.querySelector('cart-notification');
      const body = { items: [this.mainItem(), ...this.selectedPicks()] };
      if (cart && typeof cart.getSectionsToRender === 'function') {
        body.sections = cart.getSectionsToRender().map((section) => section.id);
        body.sections_url = window.location.pathname;
        if (typeof cart.setActiveElement === 'function') cart.setActiveElement(this.submitter || document.activeElement);
      }

      button.setAttribute('aria-disabled', 'true');
      button.classList.add('loading');
      this.hideError();

      try {
        const response = await fetch(`${this.dataset.cartAddUrl}.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await response.json();

        if (!response.ok || data.status) {
          this.showError(data.description || data.message);
          if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
            publish(PUB_SUB_EVENTS.cartError, { source: 'complete-the-look', errors: data.description || data.message });
          }
          return;
        }

        if (typeof publish === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
          publish(PUB_SUB_EVENTS.cartUpdate, { source: 'complete-the-look', productVariantId: body.items[0].id, cartData: data });
        }
        this.close();

        if (cart && typeof cart.renderContents === 'function') {
          // Dawn's drawer and notification expect a single line item plus `sections`.
          cart.classList.remove('is-empty');
          cart.renderContents({ ...data.items[0], sections: data.sections });
        } else {
          window.location = this.dataset.cartUrl;
        }
      } catch (error) {
        console.error('[complete-the-look]', error);
        this.showError(window.cartStrings ? window.cartStrings.error : 'Something went wrong. Please try again.');
      } finally {
        button.removeAttribute('aria-disabled');
        button.classList.remove('loading');
      }
    }

    /* ---------- helpers ---------- */

    setButtonLoading(loading) {
      const button = this.form && this.form.querySelector('[type="submit"]');
      if (!button) return;
      const spinner = button.querySelector('.loading__spinner');
      button.classList.toggle('loading', loading);
      if (spinner) spinner.classList.toggle('hidden', !loading);
      if (loading) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }

    showError(message) {
      const error = this.dialog.querySelector('[data-ctl-error]');
      if (!error) return;
      error.textContent = message;
      error.hidden = false;
    }

    hideError() {
      const error = this.dialog.querySelector('[data-ctl-error]');
      if (error) error.hidden = true;
    }

    get storageKey() {
      return `complete-the-look:${this.dataset.sectionId}`;
    }

    wasShown() {
      try {
        return sessionStorage.getItem(this.storageKey) === '1';
      } catch (error) {
        return false;
      }
    }

    rememberShown() {
      if (this.dataset.oncePerSession !== 'true') return;
      try {
        sessionStorage.setItem(this.storageKey, '1');
      } catch (error) {
        /* storage blocked */
      }
    }

    /* Theme editor: open while the section is selected, with the server-rendered default variant. */
    onSectionSelect(event) {
      if (event.detail.sectionId === this.dataset.sectionId && !this.dialog.open) this.dialog.showModal();
    }

    onSectionDeselect(event) {
      if (event.detail.sectionId === this.dataset.sectionId) this.close();
    }
  }

  customElements.define('complete-the-look', CompleteTheLook);
}
