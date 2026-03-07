import type { Schema, Struct } from '@strapi/strapi';

export interface BlogImage extends Struct.ComponentSchema {
  collectionName: 'components_blog_images';
  info: {
    displayName: 'Image';
    icon: 'landscape';
  };
  attributes: {
    image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
  };
}

export interface BlogQuote extends Struct.ComponentSchema {
  collectionName: 'components_blog_quotes';
  info: {
    displayName: 'Quote';
  };
  attributes: {
    author: Schema.Attribute.String;
    text: Schema.Attribute.Text;
  };
}

export interface BlogRichText extends Struct.ComponentSchema {
  collectionName: 'components_blog_rich_texts';
  info: {
    displayName: 'Rich Text';
  };
  attributes: {
    body: Schema.Attribute.Blocks;
  };
}

export interface GeneralSeo extends Struct.ComponentSchema {
  collectionName: 'components_general_seos';
  info: {
    displayName: 'seo';
    icon: 'check';
  };
  attributes: {
    canonical: Schema.Attribute.String;
    meta_description: Schema.Attribute.Text;
    meta_title: Schema.Attribute.Text;
    og_image: Schema.Attribute.Media<'images' | 'files' | 'videos' | 'audios'>;
    robots: Schema.Attribute.Enumeration<
      [
        'index, follow',
        'noindex, nofollow',
        'index, nofollow',
        'noindex, follow',
      ]
    >;
  };
}

declare module '@strapi/strapi' {
  export module Public {
    export interface ComponentSchemas {
      'blog.image': BlogImage;
      'blog.quote': BlogQuote;
      'blog.rich-text': BlogRichText;
      'general.seo': GeneralSeo;
    }
  }
}
