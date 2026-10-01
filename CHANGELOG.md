# Changelog

## 1.0.1

- Escape the variant title in the modal text (a quote or `<` in a variant name broke the markup).
- README: precise wording on what Dawn replaces on a variant change, and on `/cart/add.js` with `items`.

## 1.0.0

First release: Complete the look section for Dawn 15 and 16. Intercepts the product form submit, renders picks
through the Section Rendering API, adds the product and the selected picks with one `/cart/add.js` call and
hands the response to the theme's cart drawer or notification.
